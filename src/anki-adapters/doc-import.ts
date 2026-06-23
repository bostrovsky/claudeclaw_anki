/**
 * Unified document import flow.
 *
 * Replaces the per-format slash commands (/cardsfromdoc, /importdave) with
 * a single /importdoc <path> entry point. The flow:
 *
 *   1. Detect doc kind (Dave-KB-formatted HTML vs generic html/md/text)
 *   2. Stage a pending_doc_imports row + send inline-keyboard:
 *      [Add to existing] [Create new deck] [Replace existing] [Cancel]
 *   3. On action tap:
 *      - Add / Replace → list existing decks via AnkiConnect, present
 *        another keyboard for the user to pick the target.
 *      - Create new → reply "send me a deck name"; intercept next text
 *        message (handled in bot.ts).
 *   4. Once target deck is known, dispatch to the right importer:
 *      - dave-kb → importDaveBlocks (per-block focused LLM calls)
 *      - generic-html/md/text → sendCardsFromDocument
 *   5. After import, if action='replace', tag any pre-existing approved
 *      cards in that deck whose content_hash is NOT in the new batch
 *      with `deprecated:<batch_id>` via AnkiConnect's addTags. The Story 3
 *      P11 dedup (by content_hash) auto-skips unchanged cards, preserving
 *      their FSRS review history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Context, InlineKeyboard } from 'grammy';

import { createCore, type AnkiCore } from '../anki-mcp-core.js';
import {
  createDocImport,
  getDocImport,
  updateDocImport,
  getDb,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { readDocFromPath, detectDocFormat } from './document.js';
import {
  importDaveBlocks,
  parseDaveKbBlocks,
  sendImportDaveBlocks,
  type ImportDaveResult,
} from './dave-bidding-system.js';
import { generateCardsFromDocument, sendCardsFromDocument } from './document.js';
import { type CardsFromTextResult } from './text.js';
import { approvePending, getPendingCard } from '../anki-pending.js';

// ── Core lookup (shared with other adapters) ─────────────────────────

let _core: AnkiCore | null = null;
function getCore(): AnkiCore {
  if (_core) return _core;
  const env = readEnvFile(['ANKI_CONNECT_URL', 'ANKI_PROFILE']);
  const dataDir = process.env.CLAUDECLAW_DATA_DIR;
  _core = createCore({
    ankiConnectUrl:
      process.env.ANKI_CONNECT_URL || env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765',
    defaultProfile: process.env.ANKI_PROFILE || env.ANKI_PROFILE || '',
    importPathAllowedPrefixes: [os.tmpdir(), ...(dataDir ? [path.resolve(dataDir)] : [])],
  });
  return _core;
}

export function _setCoreForTests(core: AnkiCore | null): void {
  _core = core;
}

// ── Format detection ─────────────────────────────────────────────────

export type DocKind = 'dave-kb' | 'generic-html' | 'md' | 'text';

/**
 * Detect the doc kind by file extension + content sniff. Dave's HTML is
 * recognized by the presence of `block-ref: <code>KB-BP-` markers (a
 * structurally-specific pattern unlikely to appear in other content).
 *
 * The sniff samples the first 256 KB so we don't read huge files into
 * memory just for detection.
 */
export function detectDocKind(filePath: string, contentSample?: string): DocKind {
  const fmt = detectDocFormat(filePath);
  if (fmt === 'md') return 'md';
  if (fmt === 'text') return 'text';
  // HTML — check for Dave's KB-block marker
  const sample =
    contentSample ?? fs.readFileSync(filePath, { encoding: 'utf-8', flag: 'r' }).slice(0, 256 * 1024);
  if (/block-ref:\s*<code>KB-BP-\d+/i.test(sample)) {
    return 'dave-kb';
  }
  return 'generic-html';
}

/**
 * Cheap pre-flight block count for Dave's HTML so we can show the user
 * "229 KBs found" before they pick an action. Returns null for non-Dave
 * docs.
 */
export function countDaveBlocks(filePath: string): { total: number; confirmed: number } | null {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    const blocks = parseDaveKbBlocks(html);
    return {
      total: blocks.length,
      confirmed: blocks.filter((b) => b.status === 'confirmed').length,
    };
  } catch {
    return null;
  }
}

// ── Stage / kick off the import flow ─────────────────────────────────

export interface BeginImportResult {
  staging_id: number;
  detected_kind: DocKind;
  doc_path: string;
  block_count?: { total: number; confirmed: number };
}

/**
 * Validate the path + detect kind + stage a pending_doc_imports row.
 * Does NOT send any Telegram messages — caller (bot.ts) handles UX.
 */
export function beginDocImport(input: {
  chatId: string;
  agentId: string;
  docPath: string;
}): BeginImportResult {
  // readDocFromPath performs path-allowlist + null-byte + file-existence + size checks.
  // We use it just for validation here; the actual content is re-read by the
  // downstream importer when the user finalizes the action.
  const doc = readDocFromPath(input.docPath);
  const kind = detectDocKind(input.docPath, doc.content.slice(0, 256 * 1024));
  const blockCount = kind === 'dave-kb' ? countDaveBlocks(input.docPath) : null;
  const stagingId = createDocImport({
    chatId: input.chatId,
    agentId: input.agentId,
    docPath: input.docPath,
    detectedKind: kind,
    detectedBlockCount: blockCount?.total,
  });
  return {
    staging_id: stagingId,
    detected_kind: kind,
    doc_path: input.docPath,
    block_count: blockCount ?? undefined,
  };
}

/**
 * Build the initial action-pick keyboard for a staged import. Returns
 * caption text + the InlineKeyboard so bot.ts can post them together.
 */
export function actionPickKeyboard(stagingId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Add to existing deck', `dimp-action:${stagingId}:add`)
    .text('📂 Create new deck', `dimp-action:${stagingId}:new`)
    .row()
    .text('🔄 Replace existing deck', `dimp-action:${stagingId}:replace`)
    .row()
    .text('❌ Cancel', `dimp-cancel:${stagingId}`);
}

/**
 * After deck is resolved, ask the user whether to auto-import (no per-card
 * preview, matches the upstream Anki demo flow) or review each card.
 */
export function modePickKeyboard(stagingId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚡ Auto-import (no preview)', `dimp-mode:${stagingId}:auto`)
    .row()
    .text('👀 Review each card', `dimp-mode:${stagingId}:review`)
    .row()
    .text('❌ Cancel', `dimp-cancel:${stagingId}`);
}

export function summarizeDocForUser(result: BeginImportResult): string {
  const filename = path.basename(result.doc_path);
  const kindLabel =
    result.detected_kind === 'dave-kb'
      ? `Dave-bidding-system format (${result.block_count?.confirmed ?? '?'} confirmed KBs of ${result.block_count?.total ?? '?'} total)`
      : `${result.detected_kind} document`;
  return `📄 Importing **${filename}**\n${kindLabel}\n\nWhat should I do with the cards?`;
}

// ── Deck pick keyboard for Add / Replace flows ───────────────────────

export async function listExistingDecks(profile?: string): Promise<string[]> {
  const core = getCore();
  const effectiveProfile = profile || core.config.defaultProfile;
  return await core.withProfileLock(async () => {
    await core.ensureProfile(effectiveProfile);
    return await core.ankiCall<string[]>('deckNames');
  });
}

/**
 * Build a deck-pick keyboard. Each row shows up to 1 deck + a count
 * suffix. Adds a "Cancel" row at the end.
 */
export function deckPickKeyboard(stagingId: number, decks: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Filter Default and Anki-internal decks
  const filtered = decks.filter((d) => d !== 'Default');
  for (const deck of filtered) {
    // callback_data has a 64-byte cap; truncate long deck names defensively
    const safeDeck = deck.length > 40 ? deck.slice(0, 40) : deck;
    kb.text(deck, `dimp-deck:${stagingId}:${safeDeck}`).row();
  }
  if (filtered.length === 0) {
    kb.text('(no decks yet — pick "Create new deck" instead)', `dimp-cancel:${stagingId}`).row();
  }
  kb.text('❌ Cancel', `dimp-cancel:${stagingId}`);
  return kb;
}

// ── Execute the import once deck is known ────────────────────────────

export interface ExecuteImportResult {
  kind: DocKind;
  cardsProposed: number;
  daveResult?: ImportDaveResult;
  docResult?: CardsFromTextResult;
  deprecated?: number;
}

/**
 * Run the actual import using the staged row's parameters. Caller (bot.ts)
 * has already validated the deck name and updated the staging row's
 * state/action/target_deck.
 *
 * Sends Telegram previews via sendImportDaveBlocks or sendCardsFromDocument.
 * After the import, if action='replace', tags pre-existing cards in the
 * target deck whose hashes aren't in the new batch with `deprecated:<batchId>`.
 */
export async function executeDocImport(
  ctx: Context,
  stagingId: number,
  opts: { maxBlocks?: number; skip?: number; section?: string; maxCards?: number } = {},
): Promise<ExecuteImportResult> {
  const staging = getDocImport(stagingId);
  if (!staging) throw new Error(`staging row ${stagingId} not found`);
  if (!staging.target_deck) throw new Error('target_deck must be set before executeDocImport');

  const kind = staging.detected_kind as DocKind;
  const targetDeck = staging.target_deck;
  const autoApprove = staging.review_mode !== 'review';

  let result: ExecuteImportResult = { kind, cardsProposed: 0 };

  if (kind === 'dave-kb') {
    if (autoApprove) {
      const daveResult = await importDaveBlocks(staging.doc_path, {
        deck: targetDeck,
        maxBlocks: opts.maxBlocks ?? 8,
        skip: opts.skip ?? 0,
        section: opts.section,
        agentId: staging.agent_id,
        chatId: staging.chat_id,
      });
      result = { kind, cardsProposed: daveResult.pendingIds.length, daveResult };
    } else {
      const daveResult = await sendImportDaveBlocks(ctx, staging.doc_path, {
        deck: targetDeck,
        maxBlocks: opts.maxBlocks ?? 8,
        skip: opts.skip ?? 0,
        section: opts.section,
        agentId: staging.agent_id,
        chatId: staging.chat_id,
      });
      result = { kind, cardsProposed: daveResult.pendingIds.length, daveResult };
    }
  } else {
    if (autoApprove) {
      const docResult = await generateCardsFromDocument(
        { path: staging.doc_path },
        {
          deck: targetDeck,
          maxCards: opts.maxCards ?? 8,
          agentId: staging.agent_id,
          chatId: staging.chat_id,
        },
      );
      result = { kind, cardsProposed: docResult.pendingIds.length, docResult };
    } else {
      const docResult = await sendCardsFromDocument(
        ctx,
        { path: staging.doc_path },
        {
          deck: targetDeck,
          maxCards: opts.maxCards ?? 8,
          agentId: staging.agent_id,
          chatId: staging.chat_id,
        },
      );
      result = { kind, cardsProposed: docResult.pendingIds.length, docResult };
    }
  }

  // Auto-approve path: commit each pending card to Anki without per-card preview.
  if (autoApprove && result.cardsProposed > 0) {
    const pendingIds =
      result.daveResult?.pendingIds ?? result.docResult?.pendingIds ?? [];
    let approved = 0;
    const failures: Array<{ id: number; error: string }> = [];
    for (const id of pendingIds) {
      try {
        await approvePending(id);
        approved++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ id, error: msg });
        logger.warn({ err: msg, pendingId: id }, 'doc-import: auto-approve failed');
      }
    }
    const dupes =
      (result.daveResult ? 0 : result.docResult?.duplicates?.length ?? 0);
    const summary =
      `✅ Imported ${approved} card${approved === 1 ? '' : 's'} into "${targetDeck}"` +
      (failures.length > 0 ? ` · ${failures.length} failed` : '') +
      (dupes > 0 ? ` · ${dupes} duplicate${dupes === 1 ? '' : 's'} skipped` : '') +
      '. Open Anki Desktop to study.';
    await ctx.reply(summary);
    if (failures.length > 0) {
      const detail = failures
        .slice(0, 5)
        .map((f) => `card ${f.id}: ${f.error}`)
        .join('\n');
      await ctx.reply(`Failures (first 5):\n${detail}`);
    }
  }

  // Replace-mode deprecation pass
  if (staging.action === 'replace' && result.cardsProposed > 0) {
    try {
      result.deprecated = await tagDeprecatedReplacedCards(
        staging.agent_id,
        targetDeck,
        result.daveResult?.batchId ?? (result.docResult?.batchId as string | undefined) ?? null,
      );
    } catch (err: unknown) {
      logger.warn({ err }, 'doc-import: deprecation tagging failed');
    }
  }

  updateDocImport(stagingId, { state: 'completed' });
  return result;
}

/**
 * Identify approved cards in the target deck whose content_hash is NOT in
 * the just-imported batch. Tag them `deprecated:<batchId>` via AnkiConnect.
 *
 * The unchanged cards (content_hash matches the new batch) are skipped by
 * Story 3's P11 dedup BEFORE proposal, so they never appear in the new
 * batch's pending rows; they're still in anki_card_meta with the OLD
 * batch. We look at anki_card_meta rows for the agent + deck, exclude the
 * hashes that are also in this batch's anki_pending_cards rows (which
 * means they ARE in the new doc), and the remainder gets deprecated.
 *
 * Returns the count of cards deprecated.
 */
async function tagDeprecatedReplacedCards(
  agentId: string,
  deck: string,
  batchId: string | null,
): Promise<number> {
  if (!batchId) return 0;
  // Hashes present in the newly-proposed batch (i.e., what's IN the doc now)
  const newHashes = (getDb()
    .prepare(`SELECT content_hash FROM anki_pending_cards WHERE batch_id = ? AND content_hash IS NOT NULL`)
    .all(batchId) as Array<{ content_hash: string }>).map((r) => r.content_hash);
  const newHashSet = new Set(newHashes);

  // Hashes of previously-approved cards for this agent + deck
  const oldRows = getDb()
    .prepare(
      `SELECT anki_note_id, content_hash FROM anki_card_meta WHERE agent_id = ? AND deck = ? AND content_hash IS NOT NULL`,
    )
    .all(agentId, deck) as Array<{ anki_note_id: number; content_hash: string }>;

  const toDeprecate = oldRows.filter((r) => !newHashSet.has(r.content_hash));
  if (toDeprecate.length === 0) return 0;

  const core = getCore();
  const profile = core.config.defaultProfile;
  await core.withProfileLock(async () => {
    await core.ensureProfile(profile);
    await core.ankiCall<null>('addTags', {
      notes: toDeprecate.map((r) => r.anki_note_id),
      tags: `deprecated:${batchId}`,
    });
  });
  return toDeprecate.length;
}
