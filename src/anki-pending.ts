/**
 * Anki pending-cards approval gate.
 *
 * When any agent proposes a new card (from any source), it lands in the
 * anki_pending_cards table first. The user sees the proposed card rendered
 * via Canvas in Telegram and approves / edits / rejects before the card
 * is committed to Anki via AnkiConnect. No card ever auto-commits.
 *
 * This module owns:
 *   - The pending-queue CRUD (insert / read / update status).
 *   - Card preview rendering (front+back HTML for Canvas).
 *   - Anki model bootstrap (createModel of our two stock models if absent).
 *   - Approval execution — calls AnkiConnect directly via the shared
 *     AnkiCore primitive (reuses the profile mutex / sync orchestration
 *     from anki-mcp-core.ts; no extra subprocess).
 *
 * bot.ts wires the Telegram inline-keyboard callbacks to these helpers.
 *
 * Known limitation: bot.ts's AnkiCore instance and the anki-mcp.ts
 * subprocess's AnkiCore instance each have their own profile mutex.
 * Cross-process races (bot approving while an agent is mid-MCP-call) are
 * still possible. Acceptable for v1 — Story 2 approval flow is user-driven
 * and the agent is usually idle when the user is tapping buttons. Fix is
 * a shared file-system lock or a single-writer process; defer to follow-on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { InputFile, type Context, InlineKeyboard } from 'grammy';

import { createCore, type AnkiCore } from './anki-mcp-core.js';
import basicRichModel from './anki-models/basic-rich.json' with { type: 'json' };
import clozeRichModel from './anki-models/cloze-rich.json' with { type: 'json' };
import definitionModel from './anki-models/definition.json' with { type: 'json' };
import scenarioModel from './anki-models/scenario.json' with { type: 'json' };
import comparisonModel from './anki-models/comparison.json' with { type: 'json' };
import { emitCanvasEvent } from './canvas.js';
import { renderHtmlToPng } from './canvas-render.js';
import { CANVAS_URL } from './config.js';
import { getDb } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'edited' | 'approving';

export interface PendingCardInput {
  agentId: string;
  deck: string;
  model: 'ClaudeClaw Basic Rich' | 'ClaudeClaw Cloze Rich' | string;
  fields: Record<string, string>;
  tags?: string[];
  media?: Array<{ filename: string; data: string }>;
  sourceType: string;
  sourceRef?: string;
  sourceCitation?: string;
  contentHash?: string;
  batchId?: string;
  chatId?: string;
}

export interface PendingCardRow {
  id: number;
  agent_id: string;
  proposed_at: number;
  deck: string;
  model: string;
  fields_json: string;
  tags_json: string;
  media_json: string | null;
  source_type: string;
  source_ref: string | null;
  source_citation: string | null;
  content_hash: string | null;
  batch_id: string | null;
  chat_id: string | null;
  preview_message_id: number | null;
  anki_note_id: number | null;
  decided_at: number | null;
  status: PendingStatus;
}

export interface PendingCard {
  id: number;
  agentId: string;
  proposedAt: number;
  deck: string;
  model: string;
  fields: Record<string, string>;
  tags: string[];
  media: Array<{ filename: string; data: string }>;
  sourceType: string;
  sourceRef: string | null;
  sourceCitation: string | null;
  contentHash: string | null;
  batchId: string | null;
  chatId: string | null;
  previewMessageId: number | null;
  ankiNoteId: number | null;
  decidedAt: number | null;
  status: PendingStatus;
}

// ── Module-level AnkiCore (shared per process; honors the P1 mutex) ──

let _core: AnkiCore | null = null;

/**
 * Lazy core construction so test files that mock fetch can inject their
 * own core via setSharedCore() before this module's first use.
 */
function getCore(): AnkiCore {
  if (_core) return _core;
  const dataDir = process.env.CLAUDECLAW_DATA_DIR;
  const importPathAllowedPrefixes = [os.tmpdir(), ...(dataDir ? [path.resolve(dataDir)] : [])];
  // Read ANKI_PROFILE / ANKI_CONNECT_URL from the tenant .env (same pattern
  // as anki-mcp.ts). launchd's plist only sets CLAUDECLAW_DATA_DIR; tenant-
  // specific Anki config lives in the .env file, and process.env doesn't
  // mirror it unless code explicitly bridges via readEnvFile.
  const env = readEnvFile(['ANKI_CONNECT_URL', 'ANKI_PROFILE']);
  _core = createCore({
    ankiConnectUrl:
      process.env.ANKI_CONNECT_URL || env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765',
    defaultProfile: process.env.ANKI_PROFILE || env.ANKI_PROFILE || '',
    importPathAllowedPrefixes,
  });
  return _core;
}

/** Test seam — inject a stub core. */
export function _setCoreForTests(core: AnkiCore | null): void {
  _core = core;
}

// ── Card model bootstrap ──────────────────────────────────────────────

interface CardModelSpec {
  modelName: string;
  inOrderFields: string[];
  css: string;
  isCloze: boolean;
  cardTemplates: Array<{ Name?: string; Front: string; Back: string }>;
}

// Stock models are JSON files in ./anki-models/. They're imported statically
// so the bundled dist/ doesn't need a runtime filesystem dependency, and so
// tsc's resolveJsonModule typecheck catches schema drift at compile time.
function loadStockModels(): CardModelSpec[] {
  return [
    basicRichModel as CardModelSpec,
    clozeRichModel as CardModelSpec,
    definitionModel as CardModelSpec,
    scenarioModel as CardModelSpec,
    comparisonModel as CardModelSpec,
  ];
}

// P10 fix: per-process cache of "stock models already loaded for profile X."
// modelNames is one HTTP round-trip per approve when uncached; for batch flows
// that's N × latency for no behavior change. createModel is itself idempotent
// in the MCP layer, but we still benefit from skipping the modelNames probe.
// Key is the profile name; value true means we've verified both stock models
// were either present or just created during this process's lifetime.
const _profileModelsCache = new Set<string>();

/** Test seam — invalidate the model-bootstrap cache. */
export function _clearStockModelCacheForTests(): void {
  _profileModelsCache.clear();
}

/**
 * Ensure the two stock card models exist in the given Anki profile.
 * Caches per-profile so repeat approves don't re-probe AnkiConnect.
 * createModel is itself idempotent (skipped if name exists), so even
 * a cache miss is safe to issue.
 */
export async function ensureStockModelsLoaded(profile: string): Promise<{ created: string[]; existing: string[] }> {
  const core = getCore();
  const cacheKey = profile || '<default>';
  if (_profileModelsCache.has(cacheKey)) {
    return { created: [], existing: loadStockModels().map((s) => s.modelName) };
  }
  const created: string[] = [];
  const existing: string[] = [];
  await core.withProfileLock(async () => {
    await core.ensureProfile(profile);
    const have = await core.ankiCall<string[]>('modelNames');
    for (const spec of loadStockModels()) {
      if (have.includes(spec.modelName)) {
        existing.push(spec.modelName);
        continue;
      }
      await core.ankiCall<number>('createModel', spec as unknown as Record<string, unknown>);
      created.push(spec.modelName);
    }
  });
  _profileModelsCache.add(cacheKey);
  return { created, existing };
}

// ── Pending-queue CRUD ────────────────────────────────────────────────

function db(): Database.Database {
  return getDb();
}

function rowToCard(row: PendingCardRow): PendingCard {
  // P11 fix: defensively handle empty-string media_json (would throw on JSON.parse('')).
  const media =
    row.media_json && row.media_json.length > 0
      ? (JSON.parse(row.media_json) as Array<{ filename: string; data: string }>)
      : [];
  return {
    id: row.id,
    agentId: row.agent_id,
    proposedAt: row.proposed_at,
    deck: row.deck,
    model: row.model,
    fields: JSON.parse(row.fields_json) as Record<string, string>,
    tags: JSON.parse(row.tags_json) as string[],
    media,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceCitation: row.source_citation,
    contentHash: row.content_hash,
    batchId: row.batch_id,
    chatId: row.chat_id,
    previewMessageId: row.preview_message_id,
    ankiNoteId: row.anki_note_id,
    decidedAt: row.decided_at,
    status: row.status,
  };
}

// P9 fix: per-card media payload cap. Same surface as Story 1's storeMediaFile;
// JSON.stringify of a multi-MB base64 string allocates ~2× memory and gets
// stored in SQLite + re-encoded on approve. Reject early.
const MEDIA_MAX_TOTAL_BASE64 = 10_000_000;
function validateMediaCap(media: Array<{ filename: string; data: string }>): void {
  let total = 0;
  for (const m of media) {
    if (typeof m.data !== 'string') {
      throw new Error(`media[].data must be a base64 string (got ${typeof m.data})`);
    }
    total += m.data.length;
    if (total > MEDIA_MAX_TOTAL_BASE64) {
      throw new Error(
        `media payload too large: ${total} base64 bytes (max ${MEDIA_MAX_TOTAL_BASE64}). ` +
          'Compress or split before proposing.',
      );
    }
  }
}

export function proposePendingCard(input: PendingCardInput): PendingCard {
  if (input.media && input.media.length > 0) {
    validateMediaCap(input.media);
  }
  const now = Date.now();
  const info = db()
    .prepare(
      `INSERT INTO anki_pending_cards (
        agent_id, proposed_at, deck, model, fields_json, tags_json, media_json,
        source_type, source_ref, source_citation, content_hash, batch_id, chat_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      input.agentId,
      now,
      input.deck,
      input.model,
      JSON.stringify(input.fields),
      JSON.stringify(input.tags ?? []),
      input.media ? JSON.stringify(input.media) : null,
      input.sourceType,
      input.sourceRef ?? null,
      input.sourceCitation ?? null,
      input.contentHash ?? null,
      input.batchId ?? null,
      input.chatId ?? null,
    );
  return getPendingCard(Number(info.lastInsertRowid))!;
}

export function proposePendingBatch(inputs: PendingCardInput[]): { batchId: string; cards: PendingCard[] } {
  const batchId = inputs[0]?.batchId ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cards: PendingCard[] = [];
  const tx = db().transaction((items: PendingCardInput[]) => {
    for (const input of items) {
      cards.push(proposePendingCard({ ...input, batchId }));
    }
  });
  tx(inputs);
  return { batchId, cards };
}

export function getPendingCard(id: number): PendingCard | null {
  const row = db().prepare(`SELECT * FROM anki_pending_cards WHERE id = ?`).get(id) as PendingCardRow | undefined;
  return row ? rowToCard(row) : null;
}

export function listPendingByBatch(batchId: string, statusFilter: PendingStatus | 'any' = 'pending'): PendingCard[] {
  const sql =
    statusFilter === 'any'
      ? `SELECT * FROM anki_pending_cards WHERE batch_id = ? ORDER BY id ASC`
      : `SELECT * FROM anki_pending_cards WHERE batch_id = ? AND status = ? ORDER BY id ASC`;
  const rows =
    statusFilter === 'any'
      ? (db().prepare(sql).all(batchId) as PendingCardRow[])
      : (db().prepare(sql).all(batchId, statusFilter) as PendingCardRow[]);
  return rows.map(rowToCard);
}

export function listPendingByAgent(agentId: string, limit = 25): PendingCard[] {
  const rows = db()
    .prepare(
      `SELECT * FROM anki_pending_cards WHERE agent_id = ? AND status = 'pending' ORDER BY proposed_at ASC LIMIT ?`,
    )
    .all(agentId, limit) as PendingCardRow[];
  return rows.map(rowToCard);
}

export function updatePendingFields(id: number, fields: Record<string, string>): PendingCard | null {
  const card = getPendingCard(id);
  if (!card) return null;
  // P5 fix: refuse edits to terminally-decided cards. Without this guard, an
  // 'approved' card could be flipped back to 'edited' and approved again,
  // producing a SECOND Anki note from the same pending row.
  if (card.status === 'approved' || card.status === 'rejected') {
    throw new Error(
      `pending card ${id} is ${card.status}; cannot edit. Propose a new card instead.`,
    );
  }
  const merged = { ...card.fields, ...fields };
  db()
    .prepare(`UPDATE anki_pending_cards SET fields_json = ?, status = 'edited' WHERE id = ?`)
    .run(JSON.stringify(merged), id);
  return getPendingCard(id);
}

export function setPreviewMessageId(id: number, messageId: number): void {
  db().prepare(`UPDATE anki_pending_cards SET preview_message_id = ? WHERE id = ?`).run(messageId, id);
}

function markStatus(id: number, status: PendingStatus, ankiNoteId?: number | null): void {
  db()
    .prepare(`UPDATE anki_pending_cards SET status = ?, decided_at = ?, anki_note_id = ? WHERE id = ?`)
    .run(status, Date.now(), ankiNoteId ?? null, id);
}

// ── Preview rendering ─────────────────────────────────────────────────

// P12 fix: also escape quotes. Currently the helper is used only in body
// content, but a future caller reusing it inside an attribute context
// would silently allow attribute injection without the quote escapes.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a pending card as a Canvas-friendly HTML preview.
 *
 * Shows the card the way Anki would render it (front, then back below a
 * divider), styled to match the Canvas dark theme already used elsewhere.
 * Allows raw HTML in field content (Anki cards are HTML) but escapes
 * the surrounding labels and metadata. This is for user-facing review:
 * the user is approving the EXACT HTML that will land in Anki.
 */
/**
 * Per-archetype block plan: which fields render in what order, with which
 * label and which color side (front=blue, back=yellow, source=purple).
 * Source is always pinned last and excluded from this plan (handled below).
 */
interface FieldBlock {
  label: string;
  field: string;
  side: 'front' | 'back';
  required: boolean;
  isCloze?: boolean;
}
function archetypeBlocks(modelName: string): FieldBlock[] {
  // Exact match against known archetype names. Substring matching would
  // silently misroute a future model name like "ClaudeClaw Cloze Comparison".
  // Unknown names fall through to the Basic Front/Back layout, which is a
  // safe default since basic.css renders any string fields cleanly.
  switch (modelName) {
    case 'ClaudeClaw Cloze Rich':
      return [
        { label: 'Cloze', field: 'Text', side: 'front', required: true, isCloze: true },
        { label: 'Extra', field: 'BackExtra', side: 'back', required: false },
      ];
    case 'ClaudeClaw Definition':
      return [
        { label: 'Term', field: 'Term', side: 'front', required: true },
        { label: 'Definition', field: 'Definition', side: 'back', required: true },
        { label: 'Example', field: 'Example', side: 'back', required: false },
      ];
    case 'ClaudeClaw Scenario':
      return [
        { label: 'Setup', field: 'Setup', side: 'front', required: true },
        { label: 'Question', field: 'Question', side: 'front', required: true },
        { label: 'Answer', field: 'Answer', side: 'back', required: true },
        { label: 'Why', field: 'Why', side: 'back', required: false },
      ];
    case 'ClaudeClaw Comparison':
      return [
        { label: 'A', field: 'ConceptA', side: 'front', required: true },
        { label: 'B', field: 'ConceptB', side: 'front', required: true },
        { label: 'Difference', field: 'Difference', side: 'back', required: true },
      ];
    case 'ClaudeClaw Basic Rich':
    default:
      return [
        { label: 'Front', field: 'Front', side: 'front', required: true },
        { label: 'Back', field: 'Back', side: 'back', required: true },
      ];
  }
}

export function renderPendingPreviewHtml(card: PendingCard, position?: { index: number; total: number }): string {
  // Highlight cloze markers visually so the user can see what's being
  // tested even before answering. {{c1::answer::hint}} → answer as a
  // pill-styled span.
  // Render the cloze with answers HIDDEN (the actual study question — what
  // the user sees first in Anki review). Each {{c1::answer}} becomes a
  // labeled blank like [ ___1___ ] so it's obvious there's something to
  // recall and which cloze group it belongs to.
  function clozeQuestion(s: string): string {
    return s.replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g, (_, num: string, _answer: string, hint?: string) => {
      const hintTxt = hint ? ` <span class="cloze-hint">(${hint})</span>` : '';
      return `<span class="cloze-blank">[ ___${num}___ ]${hintTxt}</span>`;
    });
  }
  // Render the cloze with answers REVEALED — the "answer" state.
  function clozeAnswer(s: string): string {
    return s.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_, answer: string, hint?: string) => {
      const inside = hint ? `${answer} <span class="cloze-hint">(${hint})</span>` : answer;
      return `<span class="cloze">${inside}</span>`;
    });
  }

  // Story 7 fix: card fields reference auto-diagrams via bare filenames
  // (<img src="claudeclaw-XXX.png">). Anki Desktop resolves these via its
  // media collection after storeMediaFile, but the Canvas preview has no
  // such filesystem — the bare-filename src would render as a broken
  // image and (under the strict img-src data: CSP) load nothing. Inline
  // each media item as a data: URL so the preview matches what the user
  // will see in Anki.
  const mediaByFilename = new Map(card.media.map((m) => [m.filename, m.data]));
  function inlineMedia(html: string): string {
    if (mediaByFilename.size === 0) return html;
    return html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (full, before, src, after) => {
      const data = mediaByFilename.get(src);
      if (!data) return full; // unknown filename — leave it (will be broken; logged downstream)
      return `<img ${before}src="data:image/png;base64,${data}"${after}>`;
    });
  }

  const blocks = archetypeBlocks(card.model);
  const renderedBlocks: string[] = [];
  for (const b of blocks) {
    const raw = card.fields[b.field];
    if (!raw || raw.trim().length === 0) {
      // Required-but-empty fields render a placeholder so the user sees what's
      // missing. Optional-but-empty fields are skipped silently.
      if (!b.required) continue;
      renderedBlocks.push(
        `<div class="label">${escHtml(b.label)}</div><div class="${b.side}"><em>(no ${b.label.toLowerCase()})</em></div>`,
      );
      continue;
    }
    const withMedia = inlineMedia(raw);
    if (b.isCloze) {
      // Cloze block: emit BOTH the question form (blanks) and the answer
      // form (revealed) so the preview reads like an actual review card —
      // not a single "answered" state which makes it look like there's no
      // question being asked.
      renderedBlocks.push(
        `<div class="label">Question</div><div class="${b.side}">${clozeQuestion(withMedia)}</div>`,
      );
      renderedBlocks.push(
        `<div class="label">Answer (revealed)</div><div class="back">${clozeAnswer(withMedia)}</div>`,
      );
    } else {
      renderedBlocks.push(
        `<div class="label">${escHtml(b.label)}</div><div class="${b.side}">${withMedia}</div>`,
      );
    }
  }
  const source = card.fields.Source || card.sourceCitation || '';
  // P15 fix: clamp position so caller errors render sanely (no "Card 5 of 3").
  let positionLabel = '';
  if (position && position.total > 1) {
    const safeIndex = Math.max(1, Math.min(position.index, position.total));
    positionLabel = `Card ${safeIndex} of ${position.total}`;
  }

  // P6 fix: Content-Security-Policy meta tag for defense-in-depth. Front/Back
  // are intentionally rendered raw (Anki cards are HTML) but if a future
  // adapter ingests adversarial content (e.g. a YouTube transcript that
  // includes <script>), this prevents network exfil from the Playwright
  // tab. We allow inline styles (the model templates rely on them) and
  // data: images (for any embedded screenshots), but block scripts and
  // any outbound network entirely.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Card Preview</title>
<style>
  body { margin: 0; padding: 24px; background: #0f1419; color: #e1e7ef;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
         font-size: 17px; line-height: 1.5; }
  .header { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
            color: #6b7280; margin-bottom: 4px; }
  .position { font-size: 12px; color: #9ca3af; margin-bottom: 16px; }
  .deck { display: inline-block; font-size: 13px; padding: 3px 10px; border-radius: 999px;
          background: rgba(56,189,248,0.12); color: #7dd3fc; margin-bottom: 8px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
           color: #94a3b8; margin: 16px 0 6px; }
  .front, .back { font-size: 18px; color: #f1f5f9; padding: 14px;
                  background: rgba(255,255,255,0.04); border-radius: 8px;
                  border-left: 3px solid #38bdf8; }
  .back { border-left-color: #fbbf24; }
  .cloze { display: inline-block; padding: 1px 8px; margin: 0 2px;
           background: rgba(56,189,248,0.18); color: #7dd3fc;
           border-radius: 4px; font-weight: 600; }
  .cloze-blank { display: inline-block; padding: 1px 10px; margin: 0 3px;
                 background: rgba(251,191,36,0.16); color: #fbbf24;
                 border: 1px dashed rgba(251,191,36,0.5); border-radius: 4px;
                 font-weight: 600; letter-spacing: 0.04em; }
  .cloze-hint { font-weight: 400; font-style: italic; opacity: 0.7; font-size: 0.9em; }
  .meta { margin-top: 20px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.16);
          font-size: 13px; color: #94a3b8; }
  .meta div { margin: 4px 0; }
  .meta b { color: #cbd5e1; font-weight: 600; }
  strong { color: #f1f5f9; }
  code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px;
         font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.92em; }
  img { max-width: 100%; height: auto; max-height: 360px; object-fit: contain;
        display: block; margin: 8px auto; border-radius: 6px;
        background: rgba(0,0,0,0.25); }
  img.auto-diagram { max-height: 320px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 15px; }
  th, td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }
  th { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  ul, ol { padding-left: 20px; margin: 4px 0; }
</style></head>
<body>
  <div class="header">Pending Card · Awaiting Approval</div>
  ${positionLabel ? `<div class="position">${escHtml(positionLabel)}</div>` : ''}
  <div class="deck">${escHtml(card.deck)}</div>
  ${renderedBlocks.join('\n  ')}
  ${source ? `<div class="label">Source</div><div class="back" style="border-left-color:#a78bfa">${escHtml(source)}</div>` : ''}
  <div class="meta">
    <div><b>Model:</b> ${escHtml(card.model)}</div>
    <div><b>Tags:</b> ${card.tags.length > 0 ? card.tags.map(escHtml).join(', ') : '(none)'}</div>
    ${card.sourceType ? `<div><b>Source type:</b> ${escHtml(card.sourceType)}</div>` : ''}
    ${card.sourceCitation ? `<div><b>Citation:</b> ${escHtml(card.sourceCitation)}</div>` : ''}
    ${card.sourceRef ? `<div><b>Source ref:</b> ${escHtml(card.sourceRef)}</div>` : ''}
  </div>
</body></html>`;
}

// ── Telegram preview + approval keyboard ──────────────────────────────

function approvalKeyboard(
  card: PendingCard,
  batchPendingCount: number,
  chatId?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✅ Approve', `anki-approve:${card.id}`)
    .text('✏️ Edit', `anki-edit:${card.id}`)
    .text('❌ Reject', `anki-reject:${card.id}`);
  if (card.batchId && batchPendingCount > 1) {
    kb.row().text(`✅✅ Approve all ${batchPendingCount}`, `anki-approve-batch:${card.batchId}`);
  }
  // Add a "Open in Canvas" Mini App button when CANVAS_URL is configured.
  // Tapping launches the Canvas Mini App with the full card HTML at any
  // resolution — easier to read than the inline PNG, especially on desktop
  // Telegram where the photo is shrunk.
  if (CANVAS_URL && chatId) {
    const canvasUrl = `${CANVAS_URL}${CANVAS_URL.includes('?') ? '&' : '?'}chatId=${chatId}&v=${Date.now()}`;
    kb.row().webApp('🔍 Open in Canvas', canvasUrl);
  }
  return kb;
}

/**
 * Send a Telegram preview for one pending card. Renders the HTML through
 * the existing canvas-render pipeline (Playwright) to a PNG, sends as a
 * photo with the approval inline-keyboard attached, and records the
 * Telegram message_id back to the pending row so subsequent edits/decides
 * can edit the same message.
 *
 * Caption is intentionally short (under Telegram's 1024-char cap) and
 * carries the deck + source so the user has context even if the photo
 * preview hasn't loaded.
 */
export async function sendPendingPreview(
  ctx: Context,
  card: PendingCard,
  position?: { index: number; total: number },
): Promise<void> {
  const html = renderPendingPreviewHtml(card, position);
  const chatIdStr = ctx.chat?.id.toString();
  // Push the rendered HTML to the Canvas SSE channel so the Mini App can
  // serve it when the user taps "Open in Canvas". Each preview replaces the
  // canvas content — in a batch review the user sees whichever card they
  // last had open. Best-effort; canvas server may not be configured.
  //
  // Story 7 fix: the data:image/png;base64 URLs inlined by
  // renderPendingPreviewHtml can push the HTML past 1 MB. Pushing that over
  // SSE through the Tailscale tunnel saturates the EventSource client and
  // can cause the Mini App to drop the whole event. For the Mini App push,
  // replace each inline base64 image with a lightweight placeholder so the
  // payload stays small. The canonical visual is the inline photo in the
  // Telegram chat; the Mini App preserves structure+text.
  if (CANVAS_URL && chatIdStr) {
    try {
      // Strip the <meta http-equiv="Content-Security-Policy"> tag before
      // pushing to the Canvas Mini App. The PNG-render pipeline (Playwright)
      // needs the full <!DOCTYPE html>...<meta CSP>...</html> wrapper to
      // render as a standalone page. The Mini App, however, assigns
      // payload.content directly to wrapper.innerHTML — which strips
      // <html>/<head>/<body> but RETAINS any <meta> tags inside them. The
      // CSP meta then takes effect on the live Mini App DOM, applying
      // default-src 'none' globally and breaking subsequent content.
      //
      // The inlined data: image URLs are KEPT — the whole point of the
      // Mini App is to show rich content INCLUDING diagrams. SSE handles
      // multi-MB single events fine; EventSource has no per-event size
      // limit in modern browsers, and Tailscale Funnel passes them through.
      const miniAppHtml = html.replace(
        /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
        '',
      );
      emitCanvasEvent(chatIdStr, { type: 'html', content: miniAppHtml });
    } catch (err) {
      logger.warn({ err }, 'canvas push for pending preview failed');
    }
  }
  const pngPath = await renderHtmlToPng(html);
  if (!pngPath) {
    // Canvas failed — fall back to text-only preview so the user can still decide.
    // P4 fix: drop parse_mode 'Markdown' so adversarial LLM content with
    // unbalanced * / _ / [ / ` doesn't crash the preview message. The labels
    // are short enough to scan without bold formatting.
    //
    // Story 6 P2 fix: reuse archetypeBlocks so non-Basic cards (scenario,
    // comparison, definition) show their actual field labels in the
    // text-only fallback instead of "(no front) / (no back)".
    const blocks = archetypeBlocks(card.model);
    const lines: string[] = [];
    for (const b of blocks) {
      const raw = card.fields[b.field];
      if (!raw || raw.trim().length === 0) {
        if (!b.required) continue;
        lines.push(`${b.label}: (no ${b.label.toLowerCase()})`);
        continue;
      }
      // strip HTML for plain text view, cap length
      const plain = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
      lines.push(`${b.label}: ${plain}`);
    }
    const batchPending = card.batchId ? listPendingByBatch(card.batchId, 'pending').length : 1;
    const message = await ctx.reply(
      `📇 Pending card (id ${card.id})${position ? ` · ${position.index} of ${position.total}` : ''}\n\n` +
        `Deck: ${card.deck}\n\n` +
        lines.join('\n\n') +
        (card.sourceCitation ? `\n\nSource: ${card.sourceCitation}` : ''),
      {
        reply_markup: approvalKeyboard(card, batchPending, chatIdStr),
      },
    );
    setPreviewMessageId(card.id, message.message_id);
    return;
  }

  const batchPending = card.batchId ? listPendingByBatch(card.batchId, 'pending').length : 1;
  const caption =
    `📇 Card ${position ? `${position.index} of ${position.total}` : `(id ${card.id})`} — ${card.deck}` +
    (card.sourceCitation ? `\nSource: ${card.sourceCitation}` : '');

  try {
    const message = await ctx.replyWithPhoto(new InputFile(pngPath), {
      caption: caption.slice(0, 1000),
      reply_markup: approvalKeyboard(card, batchPending, chatIdStr),
    });
    setPreviewMessageId(card.id, message.message_id);
  } finally {
    fs.unlink(pngPath, () => {});
  }
}

// ── Approval execution ────────────────────────────────────────────────

export interface ApproveResult {
  ankiNoteId: number;
  syncOk: boolean;
  syncError?: string;
}

/**
 * Commit a pending card to Anki via AnkiConnect.
 *
 * Bootstraps stock models if needed (cached per profile after first call),
 * atomically claims the pending row via a conditional UPDATE (rejects
 * double-tap reentrancy), then issues addNote inside the profile mutex,
 * records anki_card_meta provenance, and marks the pending row 'approved'.
 * Returns the new Anki note ID + sync state.
 */
export async function approvePending(id: number): Promise<ApproveResult> {
  const card = getPendingCard(id);
  if (!card) throw new Error(`pending card ${id} not found`);

  // P2 fix: atomic claim. UPDATE returns rowcount; we proceed only if we
  // flipped the row from pending|edited to 'approving' (a transient state
  // visible until markStatus writes 'approved' or we revert on failure).
  // Two concurrent approvePending calls on the same id: only one wins the
  // UPDATE. The other sees changes=0 and bails.
  const claimResult = db()
    .prepare(
      `UPDATE anki_pending_cards SET status = 'approving' WHERE id = ? AND status IN ('pending', 'edited')`,
    )
    .run(id);
  if (claimResult.changes === 0) {
    // Re-read to give the caller a precise error reason.
    const current = getPendingCard(id);
    throw new Error(
      `pending card ${id} is ${current?.status ?? 'missing'}; cannot approve`,
    );
  }

  const core = getCore();
  // core.config.defaultProfile already resolved via readEnvFile in getCore().
  const profile = core.config.defaultProfile;

  // P8 fix: auto-apply source:<sourceType> tag so the Story 5 diagnostic
  // loop can pivot by source category. Don't duplicate if caller already
  // included it. Anki tag convention disallows spaces; the source-ref
  // version is intentionally NOT applied (would explode tag cardinality).
  const sourceTag = `source:${card.sourceType.replace(/\s+/g, '_')}`;
  const tagsWithSource = card.tags.includes(sourceTag) ? card.tags : [...card.tags, sourceTag];

  try {
    // Ensure stock models exist for this profile (cached after first call).
    await ensureStockModelsLoaded(profile);

    return await core.withProfileLock(async () => {
      await core.ensureProfile(profile);

      for (const m of card.media) {
        await core.ankiCall<string>('storeMediaFile', { filename: m.filename, data: m.data });
      }

      // Ensure deck exists (createDeck is idempotent in AnkiConnect).
      await core.ankiCall<number>('createDeck', { deck: card.deck });

      const noteId = await core.ankiCall<number>('addNote', {
        note: {
          deckName: card.deck,
          modelName: card.model,
          fields: card.fields,
          tags: tagsWithSource,
        },
      });

      // P3 fix: meta-write + final status-update happen in a single SQLite
      // transaction with INSERT OR IGNORE on the meta PK. INSERT OR IGNORE
      // makes the rare-but-real PK-conflict scenario (Anki reusing a noteId
      // after a purge, or a backup-restore race) idempotent rather than
      // fatal. If the meta row already exists for that noteId, we still
      // mark the pending row approved — provenance is already on file.
      const finalize = db().transaction(() => {
        db()
          .prepare(
            `INSERT OR IGNORE INTO anki_card_meta (anki_note_id, agent_id, deck, source_type, source_ref, source_citation, content_hash, generated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            noteId,
            card.agentId,
            card.deck,
            card.sourceType,
            card.sourceRef ?? null,
            card.sourceCitation ?? null,
            card.contentHash ?? null,
            Date.now(),
          );
        db()
          .prepare(
            `UPDATE anki_pending_cards SET status = 'approved', decided_at = ?, anki_note_id = ? WHERE id = ?`,
          )
          .run(Date.now(), noteId, id);
      });
      finalize();

      // Best-effort post-write sync (errors captured, not thrown).
      let syncOk = true;
      let syncError: string | undefined;
      try {
        await core.ankiCall<null>('sync', {}, 300_000);
      } catch (err: unknown) {
        syncOk = false;
        syncError = err instanceof Error ? err.message : String(err);
        logger.warn({ err: syncError, noteId, cardId: id }, 'anki post-approve sync failed');
      }

      return { ankiNoteId: noteId, syncOk, syncError };
    });
  } catch (err) {
    // Revert the atomic claim so the user (or retry path) can try again.
    // Only revert if WE made the claim — preserve a final-status overwrite
    // by other code, though there's no current writer that does so.
    db()
      .prepare(
        `UPDATE anki_pending_cards SET status = ? WHERE id = ? AND status = 'approving'`,
      )
      .run(card.status, id);
    throw err;
  }
}

export function rejectPending(id: number): PendingCard | null {
  const card = getPendingCard(id);
  if (!card) return null;
  if (card.status !== 'pending' && card.status !== 'edited') {
    return card; // already decided, no-op
  }
  markStatus(id, 'rejected');
  return getPendingCard(id);
}

/**
 * Re-render a pending card after edit. Used by the /edit-card slash
 * command and by future AskUserQuestion-bridged flows.
 */
export async function editPendingAndRePreview(
  ctx: Context,
  id: number,
  fieldUpdates: Record<string, string>,
): Promise<PendingCard | null> {
  const updated = updatePendingFields(id, fieldUpdates);
  if (!updated) return null;
  await sendPendingPreview(ctx, updated);
  return updated;
}
