/**
 * Dave-bidding-system HTML importer.
 *
 * Dave's HTML doc carries 250+ knowledge blocks structured as:
 *   <h2 class="section-heading">{section title}</h2>
 *   ...
 *   <div class="principle">
 *     <h4 class="principle-heading">{block title} <span class="badge {status}">{status_text}</span></h4>
 *     <p class="block-ref">block-ref: <code>KB-BP-{NNN}</code></p>
 *     <span class="field-label">Statement</span>
 *     <p>{content}</p>
 *     <span class="field-label">{other field}</span>
 *     <p>{content}</p>
 *   </div>
 *
 * This adapter parses out the structured blocks, filters by status (default:
 * 'confirmed' only — Dave's blessed content), and feeds each block's content
 * as a focused source to the cards-from-text LLM pipeline. Each block becomes
 * a focused mini-source so the LLM produces 1-3 high-quality cards per Dave
 * principle rather than mush across the whole doc.
 *
 * Pagination is built in (skip / max) because 250+ blocks × 1-3 cards is
 * way too many to approve in one sitting. Default: 20 cards-worth of blocks
 * per batch.
 */
import path from 'node:path';

import { type Context } from 'grammy';

import {
  generateCardsFromText,
  type CardsFromTextOpts,
  type CardsFromTextResult,
} from './text.js';
import { readDocFromPath } from './document.js';
import {
  getPendingCard,
  listPendingByBatch,
  proposePendingBatch,
  sendPendingPreview,
} from '../anki-pending.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { type CardDraft } from './prompts.js';

export type DaveBlockStatus = 'empty' | 'thin' | 'drafted' | 'confirmed' | 'superseded';

export interface DaveKbBlock {
  ref: string; // "KB-BP-021"
  title: string;
  status: DaveBlockStatus;
  fields: Record<string, string>; // "Statement" → "...", "Rationale" → "...", etc.
  /** Most recent <h2>/<h3> section heading before this block, e.g. "0.1 About this system". */
  section: string;
}

const BADGE_CLASS_TO_STATUS: Record<string, DaveBlockStatus> = {
  conf: 'confirmed',
  draft: 'drafted',
  thin: 'thin',
  empty: 'empty',
  superseded: 'superseded',
};

function decodeEntities(s: string): string {
  // Numeric refs first so we don't accidentally re-decode their output.
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const cp = parseInt(hex, 16);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : _;
  });
  out = out.replace(/&#(\d+);/g, (_, dec: string) => {
    const cp = parseInt(dec, 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : _;
  });
  return out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

/**
 * Find the matching `</div>` for a `<div>` opening at the given start index,
 * tracking nested `<div>` depth. Returns the index of the close, or -1 if
 * unbalanced.
 *
 * Real Dave HTML — 57% of principle blocks contain nested `<div>` children
 * (e.g. `<div class="dave-says">`, `<div class="kb-meta">`). A non-greedy
 * regex would truncate at the inner close, losing every field declared
 * after the nested child. This walker is the right fidelity guarantee.
 */
function findBalancedDivClose(html: string, openEndIdx: number): number {
  let depth = 1;
  let cursor = openEndIdx;
  while (depth > 0 && cursor < html.length) {
    const nextOpen = html.indexOf('<div', cursor);
    const nextClose = html.indexOf('</div>', cursor);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Make sure it's actually a `<div ...>` not `<divsomething` (cheap sanity)
      const next4 = html.charAt(nextOpen + 4);
      if (next4 === ' ' || next4 === '>' || next4 === '\t' || next4 === '\n') {
        depth++;
        cursor = nextOpen + 4;
      } else {
        cursor = nextOpen + 4;
      }
    } else {
      depth--;
      cursor = nextClose + '</div>'.length;
    }
  }
  return depth === 0 ? cursor : -1;
}

/**
 * Walk through Dave's HTML and extract every `<div class="principle">` block
 * with its title, status, ref, fields, and ambient section heading.
 *
 * Uses a depth-tracking walker (not a non-greedy regex) so principles with
 * nested div children (`<div class="dave-says">`, etc.) extract their full
 * body. This is critical: 57% of Dave's confirmed principles contain at
 * least one nested div, and a non-greedy regex would drop every field
 * declared after the nested child (Rationale, Worked examples, Common
 * student errors, etc.).
 */
export function parseDaveKbBlocks(html: string): DaveKbBlock[] {
  const blocks: DaveKbBlock[] = [];

  // Pre-scan for h2/h3 + principle anchor positions. Then walk in document
  // order, tracking ambient section/sub-heading.
  interface Anchor {
    kind: 'h2' | 'h3' | 'principle';
    start: number;
    contentStart: number;
    contentEnd?: number; // filled for h2/h3 (closing tag idx)
  }
  const anchors: Anchor[] = [];

  const h2Re = /<h2[^>]*class="section-heading"[^>]*>/gi;
  for (const m of html.matchAll(h2Re)) {
    const close = html.indexOf('</h2>', m.index! + m[0].length);
    if (close === -1) continue;
    anchors.push({ kind: 'h2', start: m.index!, contentStart: m.index! + m[0].length, contentEnd: close });
  }
  const h3Re = /<h3[^>]*class="sub-heading"[^>]*>/gi;
  for (const m of html.matchAll(h3Re)) {
    const close = html.indexOf('</h3>', m.index! + m[0].length);
    if (close === -1) continue;
    anchors.push({ kind: 'h3', start: m.index!, contentStart: m.index! + m[0].length, contentEnd: close });
  }
  const pRe = /<div[^>]*class="(?:[^"]*\s)?principle(?:\s[^"]*)?"[^>]*>/gi;
  for (const m of html.matchAll(pRe)) {
    anchors.push({ kind: 'principle', start: m.index!, contentStart: m.index! + m[0].length });
  }
  anchors.sort((a, b) => a.start - b.start);

  let currentH2 = '';
  let currentH3 = '';
  for (const a of anchors) {
    if (a.kind === 'h2') {
      // Strip nested spans/inline elements from heading; keep first-text-line only
      // so the section name remains compact (badge/provenance class text is dropped).
      currentH2 = cleanHeadingText(html.slice(a.contentStart, a.contentEnd));
      currentH3 = '';
      continue;
    }
    if (a.kind === 'h3') {
      currentH3 = cleanHeadingText(html.slice(a.contentStart, a.contentEnd));
      continue;
    }
    // principle
    const close = findBalancedDivClose(html, a.contentStart);
    if (close === -1) continue;
    const body = html.slice(a.contentStart, close - '</div>'.length);
    const block = parsePrincipleBody(body, currentH3 || currentH2);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Strip <span class="badge">…</span> and <span class="provenance">…</span>
 * children from a heading body, then flatten remaining HTML to a single
 * text line. Prevents section names from getting polluted with badge/
 * provenance text (e.g. "0. Foundations & System Identity GENERAL
 * drafted from-team stuff").
 */
function cleanHeadingText(htmlChunk: string): string {
  let s = htmlChunk;
  // Drop badge / provenance / scaffold / superseded markers entirely
  s = s.replace(
    /<span[^>]*class="(?:[^"]*\s)?(?:badge|provenance|superseded-note|scaffold-note)(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/span>/gi,
    '',
  );
  return stripTags(s);
}

function parsePrincipleBody(body: string, section: string): DaveKbBlock | null {
  // Pull the heading text + badge class
  const headingMatch = body.match(/<h4[^>]*class="principle-heading"[^>]*>([\s\S]*?)<\/h4>/i);
  if (!headingMatch) return null;
  const headingHtml = headingMatch[1];
  // Status: <span class="badge {status-token} ...">. The badge class
  // may carry additional tokens (e.g. "badge conf featured"), so we
  // match the badge marker then scan the full class attribute for any
  // known status word in any position.
  let status: DaveBlockStatus = 'empty';
  const badgeAttrMatch = headingHtml.match(/<span[^>]*class="([^"]*\bbadge\b[^"]*)"[^>]*>/i);
  if (badgeAttrMatch) {
    const tokens = badgeAttrMatch[1].split(/\s+/);
    for (const t of tokens) {
      const mapped = BADGE_CLASS_TO_STATUS[t];
      if (mapped) {
        status = mapped;
        break;
      }
    }
  }
  const title = stripTags(headingHtml.replace(/<span[^>]*class="(?:[^"]*\s)?(?:badge|provenance|superseded-note)(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/span>/gi, ''));

  // Block ref: <p class="block-ref">block-ref: <code>KB-BP-NNN</code></p>
  const refMatch = body.match(/<p[^>]*class="block-ref"[^>]*>[\s\S]*?<code>([^<]+)<\/code>/i);
  if (!refMatch) return null; // a "principle" without a block-ref isn't usable
  const ref = refMatch[1].trim();

  // Fields: each <span class="field-label">{label}</span> is followed by one
  // or more block-level elements until the next field-label (or end of body).
  // Walk the body sequentially.
  const fieldChunks = body.split(/<span[^>]*class="field-label"[^>]*>/i).slice(1);
  const fields: Record<string, string> = {};
  for (const chunk of fieldChunks) {
    const labelEnd = chunk.indexOf('</span>');
    if (labelEnd === -1) continue;
    const label = stripTags(chunk.slice(0, labelEnd));
    const rest = chunk.slice(labelEnd + '</span>'.length);
    // Content runs until either:
    //   - the start of the next field (already split off by .split())
    //   - the end of the principle body
    // Convert the rest to plain text.
    const content = stripTags(rest);
    if (label && content) fields[label] = content;
  }

  return { ref, title, status, fields, section };
}

/**
 * Compose a focused LLM source text from one block — strong context per
 * block keeps the LLM honest. Status / ref / section serve as provenance
 * hints in the prompt body itself.
 */
function blockToSourceText(block: DaveKbBlock): string {
  const lines: string[] = [];
  lines.push(`Dave's bidding system — block ${block.ref} (status: ${block.status})`);
  if (block.section) lines.push(`Section: ${block.section}`);
  lines.push(`Title: ${block.title}`);
  lines.push('');
  for (const [label, content] of Object.entries(block.fields)) {
    lines.push(`${label}: ${content}`);
  }
  return lines.join('\n');
}

export interface ImportDaveOpts {
  /** Anki deck for the imported cards (default: "Bridge::DaveSystem::<section>"). */
  deck?: string;
  /** Filter blocks by status (default: only 'confirmed'). */
  statuses?: DaveBlockStatus[];
  /** Filter by section keyword match (substring, case-insensitive). */
  section?: string;
  /** Skip the first N matching blocks (pagination). */
  skip?: number;
  /** Cap on blocks processed per call (default: 8 — yields ~8-24 cards). */
  maxBlocks?: number;
  /** Cap on cards PER block via the LLM (default: 2). */
  maxCardsPerBlock?: number;
  /** Caller-supplied LLM (tests). */
  llm?: CardsFromTextOpts['llm'];
  /** Agent id (defaults to 'main'). */
  agentId?: string;
  /** Chat id for previews. */
  chatId?: string;
}

export interface ImportDaveResult {
  totalBlocks: number;
  matchingBlocks: number;
  processedBlocks: DaveKbBlock[];
  pendingIds: number[];
  batchId?: string;
  perBlock: Array<{
    block: DaveKbBlock;
    accepted: CardDraft[];
    rejected: number;
    duplicates: number;
    /** Present when the block's LLM call threw — preserves the failure for diagnostics. */
    error?: string;
  }>;
}

/**
 * Drive the import. Returns the processed-block summary; each block has
 * been fed through generateCardsFromText, which calls proposePendingBatch.
 * To collect all proposed cards under ONE pending batch (so the user can
 * "Approve all"), pre-assign a batchId and pass it via opts.
 */
export async function importDaveBlocks(
  filePath: string,
  opts: ImportDaveOpts = {},
): Promise<ImportDaveResult> {
  const doc = readDocFromPath(filePath);
  if (doc.format !== 'html') {
    throw new Error(`expected an HTML file (got format=${doc.format})`);
  }
  const allBlocks = parseDaveKbBlocks(doc.content);
  const wantedStatuses = opts.statuses ?? ['confirmed'];
  let matching = allBlocks.filter((b) => wantedStatuses.includes(b.status));
  if (opts.section) {
    const needle = opts.section.toLowerCase();
    matching = matching.filter((b) => b.section.toLowerCase().includes(needle));
  }
  const skip = Math.max(0, opts.skip ?? 0);
  // Cap maxBlocks at 30 so a typo like max=99999 doesn't blow through the
  // Gemini quota or block the bot for tens of minutes. User can re-run
  // with skip= to paginate.
  const maxBlocks = Math.min(30, Math.max(1, opts.maxBlocks ?? 8));
  const slice = matching.slice(skip, skip + maxBlocks);

  if (slice.length === 0) {
    return {
      totalBlocks: allBlocks.length,
      matchingBlocks: matching.length,
      processedBlocks: [],
      pendingIds: [],
      perBlock: [],
    };
  }

  // Shared batchId so all cards proposed across multiple block calls go
  // into one batch. proposePendingBatch already honors caller-provided
  // batchId via the first input.
  const sharedBatchId = `dave-${path.basename(filePath, '.html')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const perBlock: ImportDaveResult['perBlock'] = [];
  const pendingIds: number[] = [];

  // Story 7 P2 fix: per-session image budget. generateCardsFromText caps at
  // maxImages per call; we loop over up to 30 blocks here, so without a
  // cross-call cap a hallucinating LLM could fire 60+ image-gen calls in a
  // single /importdave run ($2.40 at paid-tier rates). Track total
  // attached images across the loop and shrink the per-call cap as we go.
  const SESSION_MAX_IMAGES = 8;
  let sessionImagesUsed = 0;

  for (const block of slice) {
    const deckBase = opts.deck ?? `Bridge::DaveSystem`;
    const sectionSlug = block.section
      ? `::${block.section.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
      : '';
    const deck = opts.deck ? deckBase : `${deckBase}${sectionSlug}`;

    try {
      const sourceText = blockToSourceText(block);
      const remainingImages = Math.max(0, SESSION_MAX_IMAGES - sessionImagesUsed);
      const result = await generateCardsFromText(sourceText, {
        deck,
        sourceLabel: `Dave ${block.ref} · ${block.title}`,
        sourceType: 'doc-dave-kb',
        sourceRef: `dave://${block.ref}`,
        topicHint: `Generate cards that test the principle stated in this Dave block. Preserve Dave's voice from the Statement; use his Worked examples for drill cards if present.`,
        maxCards: opts.maxCardsPerBlock ?? 2,
        maxImages: remainingImages,
        agentId: opts.agentId ?? 'main',
        chatId: opts.chatId,
        llm: opts.llm,
        batchId: sharedBatchId,
      });
      // Count images this call actually attached so the next iteration's
      // budget reflects it. We don't expose imagesAttached as a return
      // value (keeps the CardsFromTextResult contract narrow); instead
      // count rows from this call's pendingIds that have non-null media.
      if (remainingImages > 0 && result.pendingIds.length > 0) {
        const placeholders = result.pendingIds.map(() => '?').join(',');
        const row = getDb()
          .prepare(`SELECT COUNT(*) AS n FROM anki_pending_cards WHERE id IN (${placeholders}) AND media_json IS NOT NULL`)
          .get(...result.pendingIds) as { n: number };
        sessionImagesUsed += row.n;
      }
      perBlock.push({
        block,
        accepted: result.accepted,
        rejected: result.rejected.length,
        duplicates: result.duplicates.length,
      });
      pendingIds.push(...result.pendingIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg, blockRef: block.ref }, 'dave-import: block failed');
      perBlock.push({ block, accepted: [], rejected: 0, duplicates: 0, error: msg });
    }
  }

  return {
    totalBlocks: allBlocks.length,
    matchingBlocks: matching.length,
    processedBlocks: slice,
    pendingIds,
    batchId: pendingIds.length > 0 ? sharedBatchId : undefined,
    perBlock,
  };
}

/**
 * Telegram entry point. Imports + sends per-card previews in one shot.
 * Caller decides skip/max for pagination.
 */
export async function sendImportDaveBlocks(
  ctx: Context,
  filePath: string,
  opts: ImportDaveOpts = {},
): Promise<ImportDaveResult> {
  const result = await importDaveBlocks(filePath, {
    ...opts,
    chatId: opts.chatId ?? ctx.chat?.id.toString(),
  });

  const matched = result.matchingBlocks;
  const processed = result.processedBlocks.length;
  const cardsProposed = result.pendingIds.length;
  const skipUsed = opts.skip ?? 0;
  const remaining = Math.max(0, matched - skipUsed - processed);
  const failedBlocks = result.perBlock.filter((p) => p.error);

  if (processed === 0) {
    await ctx.reply(
      `Dave's bidding system — parsed ${result.totalBlocks} blocks, ${matched} match filter. ` +
        (skipUsed >= matched
          ? `Skip=${skipUsed} is past the end of matching blocks (only ${matched} match).`
          : `No blocks processed.`),
    );
    return result;
  }

  await ctx.reply(
    `Dave's bidding system — parsed ${result.totalBlocks} blocks, ${matched} match filter ` +
      `(status=${(opts.statuses ?? ['confirmed']).join('/')}${opts.section ? `, section~"${opts.section}"` : ''}). ` +
      `Processing blocks ${skipUsed + 1}-${skipUsed + processed}. ` +
      `Drafted ${cardsProposed} card${cardsProposed === 1 ? '' : 's'}` +
      (failedBlocks.length > 0 ? ` · ${failedBlocks.length} block${failedBlocks.length === 1 ? '' : 's'} failed` : '') +
      `.` +
      (remaining > 0 ? ` ${remaining} block${remaining === 1 ? '' : 's'} remaining; re-run with skip=${skipUsed + processed} to continue.` : ''),
  );

  if (failedBlocks.length > 0) {
    const detail = failedBlocks
      .slice(0, 3)
      .map((p) => `${p.block.ref}: ${p.error}`)
      .join('\n');
    await ctx.reply(`Failed blocks (first 3):\n${detail}`);
  }

  if (cardsProposed === 0) return result;

  const total = cardsProposed;
  let shown = 0;
  for (let i = 0; i < result.pendingIds.length; i++) {
    const card = getPendingCard(result.pendingIds[i]);
    if (!card) continue;
    try {
      await sendPendingPreview(ctx, card, { index: i + 1, total });
      shown++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg, cardId: card.id }, 'dave-import: preview failed');
    }
  }

  // Per-batch tail message — useful when user wants to bulk-approve.
  const batchHint =
    result.batchId && result.batchId.length > 0
      ? `Batch ID: ${result.batchId} — tap "✅✅ Approve all" on any card to commit the whole batch.`
      : '';
  if (batchHint) await ctx.reply(batchHint);
  return result;
}

/** Re-export listPendingByBatch so callers can show batch summaries without an extra import. */
export { listPendingByBatch };
