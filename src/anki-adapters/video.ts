/**
 * cards-from-video adapter.
 *
 * Gemini reads YouTube URLs natively via its File API — no yt-dlp,
 * ffmpeg, or Whisper transcription on our side. One `generateContent`
 * call with a fileData part returns the same card JSON the text path
 * produces. Cards land in the pending queue via the existing pipeline.
 *
 * Single-line entry: /importvideo <url> [deck=...] [max=N]
 */
import { type Context } from 'grammy';

import {
  proposePendingBatch,
  sendPendingPreview,
  type PendingCardInput,
  getPendingCard,
} from '../anki-pending.js';
import { getDb } from '../db.js';
import { generateContentFromVideo, parseJsonResponse } from '../gemini.js';
import { logger } from '../logger.js';
import {
  type CardDraft,
  buildCardGenerationPrompt,
  draftToFields,
  validateCardDraft,
} from './prompts.js';
import type { CardsFromTextResult } from './text.js';

export interface CardsFromVideoOpts {
  /** Anki deck the cards land in. */
  deck: string;
  /** Free-form description of the source. Defaults to "YouTube video". */
  sourceLabel?: string;
  /** Optional topic narrowing for the LLM. */
  topicHint?: string;
  /** Cap on cards (default 6, hard max 12). */
  maxCards?: number;
  /** Agent generating the cards (defaults to "main"). */
  agentId?: string;
  /** Telegram chat id for this batch. */
  chatId?: string;
  /** Test seam — override the video LLM call. */
  llm?: typeof generateContentFromVideo;
}

const YOUTUBE_URL_RE = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[A-Za-z0-9_-]{6,}|youtu\.be\/[A-Za-z0-9_-]{6,})/i;

/** Loose validation — Gemini will return an error if the URL is unusable. */
export function isYouTubeUrl(s: string): boolean {
  return YOUTUBE_URL_RE.test(s.trim());
}

/**
 * Generate cards from a YouTube URL. Calls Gemini with the URL +
 * card-generation prompt, parses JSON, validates, dedups against the
 * pending + approved queues, and proposes as a batch.
 */
export async function generateCardsFromVideo(
  videoUrl: string,
  opts: CardsFromVideoOpts,
): Promise<CardsFromTextResult> {
  const url = videoUrl.trim();
  if (url.length === 0) throw new Error('video URL is empty');

  const llm = opts.llm ?? generateContentFromVideo;
  const sourceLabel = opts.sourceLabel ?? `YouTube video: ${url}`;
  const prompt = buildCardGenerationPrompt(
    '(Generate the cards from the video provided as a fileData part — read the video directly, do not assume any text source.)',
    {
      sourceLabel,
      topicHint: opts.topicHint,
      maxCards: opts.maxCards ?? 6,
      deckHint: opts.deck,
    },
  );

  const raw = await llm(prompt, url);
  if (!raw || raw.trim().length === 0) {
    throw new Error('Gemini returned empty response. Check GOOGLE_API_KEY and the video URL.');
  }

  const parsed = parseJsonResponse<{ cards?: unknown[] } | unknown[]>(raw);
  if (!parsed) {
    throw new Error(`Gemini returned unparseable JSON. First 200 chars: ${raw.slice(0, 200)}`);
  }
  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : [];
  if (rawList.length === 0) {
    throw new Error('Gemini returned zero cards from the video. It may be too short or contain no extractable knowledge.');
  }

  const validated: CardDraft[] = [];
  const rejected: Array<{ raw: unknown; reason: string }> = [];
  for (const r of rawList) {
    const v = validateCardDraft(r);
    if (v.ok) validated.push(v.card);
    else rejected.push({ raw: r, reason: v.reason });
  }
  if (validated.length === 0) {
    logger.warn({ rejected: rejected.length, raw: raw.slice(0, 300) }, 'cards-from-video: all drafts rejected');
    return { accepted: [], rejected, duplicates: [], pendingIds: [] };
  }

  // Dedup: same content_hash matching either anki_card_meta (approved)
  // or anki_pending_cards (pending) — same rule as text path.
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
  for (const d of validated) {
    const h = hashDraft(d);
    draftHashes.set(d, h);
    if (dedupApprovedStmt.get(agentId, h) || dedupPendingStmt.get(agentId, h)) {
      duplicates.push(d);
    } else {
      accepted.push(d);
    }
  }
  if (accepted.length === 0) {
    return { accepted: [], rejected, duplicates, pendingIds: [] };
  }

  const inputs: PendingCardInput[] = accepted.map((draft) => {
    const { model, fields } = draftToFields(draft);
    return {
      agentId,
      deck: opts.deck,
      model,
      fields,
      tags: draft.tags ?? [],
      sourceType: 'youtube',
      sourceRef: url,
      sourceCitation: draft.source ?? sourceLabel,
      contentHash: draftHashes.get(draft) ?? hashDraft(draft),
      chatId: opts.chatId,
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
 * Generate cards from a YouTube URL AND send Telegram previews — the
 * /importvideo command's main entry point.
 */
export async function sendCardsFromVideo(
  ctx: Context,
  videoUrl: string,
  opts: CardsFromVideoOpts,
): Promise<CardsFromTextResult> {
  await ctx.reply(`📺 Watching the video… (Gemini reads it directly; this can take 30-90 seconds for typical clips)`);
  const result = await generateCardsFromVideo(videoUrl, opts);

  if (result.accepted.length === 0) {
    const dupes = result.duplicates.length;
    const rejects = result.rejected.length;
    if (dupes > 0 && rejects === 0) {
      await ctx.reply(`Nothing new — all ${dupes} drafts already exist in your collection.`);
    } else {
      await ctx.reply(
        `No cards generated${rejects > 0 ? ` (${rejects} rejected by validator)` : ''}. ` +
          `Try a longer video or pass a topic hint.`,
      );
    }
    return result;
  }

  const total = result.accepted.length;
  let shown = 0;
  for (let i = 0; i < result.pendingIds.length; i++) {
    const card = getPendingCard(result.pendingIds[i]);
    if (!card) continue;
    try {
      await sendPendingPreview(ctx, card, { index: i + 1, total });
      shown++;
    } catch (err: unknown) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), cardId: card.id }, 'video preview failed');
    }
  }
  const parts = [`Drafted ${total} card${total === 1 ? '' : 's'} from the video`];
  if (result.duplicates.length > 0) parts.push(`${result.duplicates.length} duplicate${result.duplicates.length === 1 ? '' : 's'} skipped`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} rejected`);
  if (shown < total) parts.push(`${shown} preview${shown === 1 ? '' : 's'} delivered`);
  await ctx.reply(parts.join(' · ') + '.');
  return result;
}

// FNV-1a — same construction text.ts uses (don't import to keep this
// module loadable without dragging the text adapter's deps).
function hashDraft(draft: CardDraft): string {
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
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
