/**
 * cards-from-text adapter.
 *
 * Takes a free-form text passage + a deck name + source metadata, runs the
 * card-generation prompt through Gemini, parses the returned JSON, validates
 * each card draft, proposes the surviving drafts as a pending-card batch,
 * and sends per-card previews via the existing Telegram approval gate.
 *
 * This is the LLM primitive that YouTube / HTML / MD / PDF adapters will
 * eventually share. Those adapters just produce text (transcript, stripped
 * HTML, etc.) and route through here.
 */
import { type Context } from 'grammy';

import {
  getPendingCard,
  proposePendingBatch,
  sendPendingPreview,
  type PendingCardInput,
} from '../anki-pending.js';
import { getDb } from '../db.js';
import { generateContent, parseJsonResponse } from '../gemini.js';
import { generateImagePng as defaultGenerateImagePng } from '../gemini-image.js';
import { logger } from '../logger.js';
import {
  type CardArchetype,
  type CardDraft,
  buildCardGenerationPrompt,
  draftToFields,
  validateCardDraft,
} from './prompts.js';

export interface CardsFromTextOpts {
  /** Anki deck the cards land in. Pre-existing or freshly created on approve. */
  deck: string;
  /** Free-form description of the source ("My Stayman chat with Coach Dave"). */
  sourceLabel: string;
  /** What this is for tag/provenance ("conversation", "doc-paste", "yt-transcript"). */
  sourceType: string;
  /** Optional structured pointer back to the source — URL, doc path, KB-ref. */
  sourceRef?: string;
  /** Optional topic narrowing — passed to the LLM as a hint. */
  topicHint?: string;
  /** Cap on how many cards the LLM may produce. Default 5. */
  maxCards?: number;
  /** Agent generating the cards (defaults to 'main' if caller omits). */
  agentId?: string;
  /** Chat id for the Telegram conversation owning this batch. */
  chatId?: string;
  /** LLM override for tests / future model swaps. */
  llm?: typeof generateContent;
  /** Image-gen override for tests. */
  imageGen?: typeof defaultGenerateImagePng;
  /**
   * Hard cap on images generated for this batch. Story 7 AC4: cap at 8 so
   * a hallucinating LLM doesn't burn $0.50 of image-gen on a single batch.
   * Default 8.
   */
  maxImages?: number;
  /**
   * If set, all cards proposed in this call land in this batch. Multiple
   * generateCardsFromText calls sharing the same batchId aggregate into
   * one approvable group. Used by the Dave-importer to group cards
   * generated across many KB blocks into one user-facing batch.
   */
  batchId?: string;
}

/**
 * Which field is the primary content slab for each archetype (where an
 * auto-diagram should land). Centralized so prompts.ts and text.ts agree.
 */
function primaryImageField(archetype: CardArchetype): string {
  switch (archetype) {
    case 'basic':
      return 'Back';
    case 'cloze':
      return 'BackExtra';
    case 'definition':
      return 'Definition';
    case 'scenario':
      return 'Answer';
    case 'comparison':
      return 'Difference';
  }
}

export interface CardsFromTextResult {
  /** Drafts the LLM produced AND passed validation AND survived dedup. */
  accepted: CardDraft[];
  /** Drafts the LLM produced but failed validation, with rejection reasons. */
  rejected: Array<{ raw: unknown; reason: string }>;
  /** Drafts skipped because an identical-hash card was already imported by this agent. */
  duplicates: CardDraft[];
  /** Batch id assigned to the proposed pending rows. Undefined if zero accepted. */
  batchId?: string;
  /** Pending row ids in the order they were proposed. */
  pendingIds: number[];
}

/**
 * Run the card-generation pipeline against a chunk of text.
 *
 * Pure-data side: returns the accepted/rejected drafts + the inserted
 * pending-row ids. Caller decides whether/how to send previews (the
 * sendCardsFromText wrapper does both).
 */
export async function generateCardsFromText(
  sourceText: string,
  opts: CardsFromTextOpts,
): Promise<CardsFromTextResult> {
  if (sourceText.trim().length === 0) {
    throw new Error('source text is empty');
  }

  const llm = opts.llm ?? generateContent;
  const prompt = buildCardGenerationPrompt(sourceText, {
    sourceLabel: opts.sourceLabel,
    topicHint: opts.topicHint,
    maxCards: opts.maxCards ?? 5,
    deckHint: opts.deck,
  });

  const raw = await llm(prompt);
  if (!raw || raw.trim().length === 0) {
    throw new Error('LLM returned empty response. Check GOOGLE_API_KEY and try again.');
  }

  // The prompt asks for an envelope `{ cards: [...] }` to make malformed
  // top-level array responses easier to recover. Be lenient: also accept
  // a bare top-level array if the model decides to skip the envelope.
  const parsed = parseJsonResponse<{ cards?: unknown[] } | unknown[]>(raw);
  if (!parsed) {
    throw new Error(`LLM returned unparseable JSON. First 200 chars: ${raw.slice(0, 200)}`);
  }
  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : [];
  if (rawList.length === 0) {
    throw new Error('LLM returned zero cards. Source might be too thin; try a different topicHint or more text.');
  }

  const validated: CardDraft[] = [];
  const rejected: Array<{ raw: unknown; reason: string }> = [];
  for (const rawDraft of rawList) {
    const validation = validateCardDraft(rawDraft);
    if (validation.ok) {
      validated.push(validation.card);
    } else {
      rejected.push({ raw: rawDraft, reason: validation.reason });
    }
  }

  if (validated.length === 0) {
    logger.warn({ rejected: rejected.length, raw: raw.slice(0, 300) }, 'cards-from-text: all drafts rejected');
    return { accepted: [], rejected, duplicates: [], pendingIds: [] };
  }

  // P11 fix: dedup against already-imported cards by content_hash. Story 2's
  // anki_card_meta table is the source of truth for "what cards has this
  // agent already approved." Skip any draft whose hash already appears.
  //
  // Story 9 P2 fix: ALSO dedup against not-yet-approved cards in the
  // pending queue. Without this, an agent that retries propose-cards-from-
  // text (e.g. user says "try again" before approving) creates duplicate
  // pending rows that the user has to reject one by one.
  const agentId = opts.agentId ?? 'main';
  const accepted: CardDraft[] = [];
  const duplicates: CardDraft[] = [];
  const dedupApprovedStmt = getDb().prepare(
    `SELECT 1 FROM anki_card_meta WHERE agent_id = ? AND content_hash = ? LIMIT 1`,
  );
  const dedupPendingStmt = getDb().prepare(
    `SELECT 1 FROM anki_pending_cards WHERE agent_id = ? AND content_hash = ? AND status IN ('pending', 'edited', 'approving') LIMIT 1`,
  );
  const draftHashes = new Map<CardDraft, string>();
  for (const draft of validated) {
    const hash = hashCard(draft);
    draftHashes.set(draft, hash);
    const inApproved = dedupApprovedStmt.get(agentId, hash);
    const inPending = dedupPendingStmt.get(agentId, hash);
    if (inApproved || inPending) {
      duplicates.push(draft);
    } else {
      accepted.push(draft);
    }
  }

  if (accepted.length === 0) {
    return { accepted: [], rejected, duplicates, pendingIds: [] };
  }

  // Story 7: optional Nano Banana image-gen for drafts flagged needsDiagram.
  // Capped per AC4 so a hallucinating LLM can't burn arbitrary image-gen
  // calls. Each call is best-effort: null means "no image, proceed without."
  const imageGen = opts.imageGen ?? defaultGenerateImagePng;
  const maxImages = opts.maxImages ?? 8;
  const draftImages = new Map<CardDraft, { filename: string; data: string }>();
  // Counter is "successfully attached," not "attempted" — a thrown or
  // null-returning imageGen call doesn't consume budget. Caps the cost
  // of successful image generations per batch.
  let imagesAttached = 0;
  for (const draft of accepted) {
    if (!draft.needsDiagram || !draft.imagePrompt) continue;
    if (imagesAttached >= maxImages) {
      logger.info({ maxImages }, 'cards-from-text: image-gen cap reached, remaining flagged cards go without diagram');
      break;
    }
    try {
      const png = await imageGen(draft.imagePrompt);
      if (!png) continue;
      const hash = draftHashes.get(draft) ?? hashCard(draft);
      const filename = `claudeclaw-${hash.slice(0, 10)}-${imagesAttached}.png`;
      draftImages.set(draft, { filename, data: png.toString('base64') });
      imagesAttached++;
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cards-from-text: image-gen threw; proceeding without image',
      );
    }
  }

  // Translate to pending-card-input shape and propose as a batch.
  // If caller supplied a batchId, every input carries it so the resulting
  // pending rows share a batch (proposePendingBatch honors the first input's
  // batchId for the whole call).
  const inputs: PendingCardInput[] = accepted.map((draft) => {
    const { model, fields } = draftToFields(draft);
    const tags = draft.tags ?? [];
    const media: Array<{ filename: string; data: string }> = [];
    const img = draftImages.get(draft);
    if (img) {
      media.push(img);
      // Prepend <img> tag to the archetype's primary content field so the
      // generated diagram appears at the top of the answer side. If the
      // target field is missing in the field map (e.g. cloze with no
      // BackExtra), create it.
      const targetField = primaryImageField(draft.model);
      const existing = fields[targetField] ?? '';
      fields[targetField] = `<img src="${img.filename}" class="auto-diagram">\n${existing}`;
    }
    return {
      agentId,
      deck: opts.deck,
      model,
      fields,
      tags,
      media: media.length > 0 ? media : undefined,
      sourceType: opts.sourceType,
      sourceRef: opts.sourceRef,
      sourceCitation: draft.source ?? opts.sourceLabel,
      contentHash: draftHashes.get(draft) ?? hashCard(draft),
      chatId: opts.chatId,
      batchId: opts.batchId,
    };
  });

  const { batchId, cards } = proposePendingBatch(inputs);
  return {
    accepted,
    rejected,
    duplicates,
    batchId,
    pendingIds: cards.map((c) => c.id),
  };
}

/**
 * High-level entry point — generate cards AND send Telegram previews for
 * each one. Returns the per-card pending ids so the caller can echo a
 * summary to the user.
 *
 * Preview-loop semantics (P9 fix):
 *   - Each preview is sent inside its own try/catch; one failure doesn't
 *     abort the rest of the batch.
 *   - The summary message is sent AFTER the loop completes, with accurate
 *     counts of "shown" vs "preview-failed". This prevents the "Drafted 5"
 *     summary that contradicted reality when previews 2-5 crashed.
 */
export async function sendCardsFromText(
  ctx: Context,
  sourceText: string,
  opts: CardsFromTextOpts,
): Promise<CardsFromTextResult> {
  const result = await generateCardsFromText(sourceText, opts);

  const noteParts: string[] = [];
  if (result.rejected.length > 0) noteParts.push(`${result.rejected.length} drafts rejected`);
  if (result.duplicates.length > 0) noteParts.push(`${result.duplicates.length} skipped as duplicate`);

  if (result.accepted.length === 0) {
    const tail = noteParts.length > 0 ? ` (${noteParts.join(', ')})` : '';
    if (result.duplicates.length > 0 && result.rejected.length === 0) {
      await ctx.reply(`Nothing new to add — all ${result.duplicates.length} drafts already exist in your collection.`);
    } else {
      await ctx.reply(
        `No cards generated${tail}.` +
          (result.rejected.length > 0 ? ' Try a different source or refine the topic hint.' : ''),
      );
    }
    return result;
  }

  const total = result.accepted.length;
  let shown = 0;
  let previewFailed = 0;
  const previewErrors: string[] = [];

  for (let i = 0; i < result.pendingIds.length; i++) {
    const card = getPendingCard(result.pendingIds[i]);
    if (!card) {
      previewFailed++;
      previewErrors.push(`card ${result.pendingIds[i]}: row vanished`);
      continue;
    }
    try {
      await sendPendingPreview(ctx, card, { index: i + 1, total });
      shown++;
    } catch (err: unknown) {
      previewFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      previewErrors.push(`card ${card.id}: ${msg}`);
      logger.warn({ err: msg, cardId: card.id }, 'cards-from-text: preview failed');
    }
  }

  // Summary AFTER the loop — counts reflect what the user actually saw.
  const summaryParts = [`Drafted ${total} card${total === 1 ? '' : 's'} from "${opts.sourceLabel}"`];
  if (shown < total) summaryParts.push(`${shown} preview${shown === 1 ? '' : 's'} delivered`);
  if (previewFailed > 0) summaryParts.push(`${previewFailed} preview${previewFailed === 1 ? '' : 's'} failed`);
  if (noteParts.length > 0) summaryParts.push(noteParts.join(', '));
  await ctx.reply(summaryParts.join(' · ') + '.');
  if (previewFailed > 0) {
    await ctx.reply(
      `Failed previews (rows are still pending — try /preview-card <id>):\n${previewErrors.slice(0, 5).join('\n').slice(0, 800)}`,
    );
  }
  return result;
}

/**
 * Stable content hash for change-tracking in the provenance ledger.
 * Same draft → same hash regardless of insertion timing. Used by future
 * Story 5+ source-sync logic to detect drift between LLM regenerations.
 *
 * Includes ALL archetype-bearing text fields so that definition/scenario/
 * comparison cards hash to distinct values (a Story 6 regression-guard).
 *
 * Intentionally excludes needsDiagram / imagePrompt: two cards with
 * identical text but differing diagram flag are considered duplicates,
 * and the first proposal wins. Re-generation with a new diagram flag is
 * a no-op rather than overwriting the existing card's media. This is
 * the simpler semantics for now; revisit if Brian asks for "regen
 * diagram only" UX.
 */
function hashCard(draft: CardDraft): string {
  const payload = JSON.stringify({
    model: draft.model,
    front: draft.front ?? '',
    back: draft.back ?? '',
    text: draft.text ?? '',
    backExtra: draft.backExtra ?? '',
    term: draft.term ?? '',
    definition: draft.definition ?? '',
    example: draft.example ?? '',
    setup: draft.setup ?? '',
    question: draft.question ?? '',
    answer: draft.answer ?? '',
    why: draft.why ?? '',
    conceptA: draft.conceptA ?? '',
    conceptB: draft.conceptB ?? '',
    difference: draft.difference ?? '',
  });
  // FNV-1a 32-bit — cheap, deterministic, no crypto-grade strength needed
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
