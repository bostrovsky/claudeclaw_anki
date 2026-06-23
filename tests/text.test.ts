import { describe, it, expect, beforeEach, vi } from 'vitest';

// Canvas render mocked so previews fall back to text; we test pipeline
// shape, not visual rendering (covered in anki-pending.test.ts).
vi.mock('../canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

import { _initTestDatabase, getDb } from '../db.js';
import { _setCoreForTests } from '../anki-pending.js';
import {
  generateCardsFromText,
  sendCardsFromText,
  type CardsFromTextOpts,
} from './text.js';
import type { AnkiCore } from '../anki-mcp-core.js';

function makeStubCore(): AnkiCore {
  return {
    ankiCall: (async () => undefined) as AnkiCore['ankiCall'],
    ensureProfile: async () => {},
    syncSafe: async () => ({ ok: true }),
    withProfileLock: async <T>(fn: () => Promise<T>) => fn(),
    validateImportPath: () => {},
    config: {
      ankiConnectUrl: 'http://stub',
      defaultProfile: 'Brian',
      fetchFn: fetch,
      defaultTimeoutMs: 30_000,
      importPathAllowedPrefixes: [],
      statSync: () => ({ isFile: () => true }),
      defaultAgentId: 'main',
    },
  };
}

function makeStubCtx(): { ctx: any; sent: any[] } {
  const sent: any[] = [];
  const ctx = {
    reply: vi.fn(async (text: string, opts?: any) => {
      sent.push({ kind: 'text', text, opts });
      return { message_id: Math.floor(Math.random() * 100000) };
    }),
    replyWithPhoto: vi.fn(async (file: any, opts?: any) => {
      sent.push({ kind: 'photo', file, opts });
      return { message_id: Math.floor(Math.random() * 100000) };
    }),
    answerCallbackQuery: vi.fn(async () => {}),
  };
  return { ctx, sent };
}

function mockLlm(payload: unknown): typeof import('../gemini.js').generateContent {
  return (async () => JSON.stringify(payload)) as typeof import('../gemini.js').generateContent;
}

const baseOpts = (overrides: Partial<CardsFromTextOpts> = {}): CardsFromTextOpts => ({
  deck: 'Bridge::Test',
  sourceLabel: 'Test source',
  sourceType: 'text-paste',
  agentId: 'main',
  ...overrides,
});

beforeEach(() => {
  _initTestDatabase();
  _setCoreForTests(makeStubCore());
});

describe('generateCardsFromText — dedup (P11 fix)', () => {
  it('skips drafts whose content_hash already exists in anki_card_meta for this agent', async () => {
    // Trigger via the production path so the hash is computed consistently.
    const draft = { model: 'basic' as const, front: 'q', back: 'a' };
    const llm1 = mockLlm({ cards: [draft] });
    const first = await generateCardsFromText('source content', baseOpts({ llm: llm1 }));
    expect(first.accepted).toHaveLength(1);
    // Read the hash production wrote, then seed anki_card_meta with it.
    const seedHash = (
      getDb()
        .prepare(`SELECT content_hash FROM anki_pending_cards LIMIT 1`)
        .get() as { content_hash: string }
    ).content_hash;
    expect(seedHash).toBeTruthy();
    getDb()
      .prepare(
        `INSERT INTO anki_card_meta (anki_note_id, agent_id, deck, source_type, source_ref, source_citation, content_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(99999, 'main', 'Bridge::Test', 'text-paste', null, null, seedHash, Date.now());
    // Now re-run with the same draft — should hit dedup
    const llm2 = mockLlm({ cards: [draft] });
    const second = await generateCardsFromText('different source text', baseOpts({ llm: llm2 }));
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(second.pendingIds).toEqual([]);
  });

  it('partitions accepted vs duplicates when a batch has both', async () => {
    // Pre-fill anki_card_meta with the hash of one specific draft
    const knownDraft = { model: 'basic' as const, front: 'known q', back: 'known a' };
    const llmFirst = mockLlm({ cards: [knownDraft] });
    const seedResult = await generateCardsFromText('seed', baseOpts({ llm: llmFirst }));
    const seedHash = (
      getDb()
        .prepare(`SELECT content_hash FROM anki_pending_cards WHERE id = ?`)
        .get(seedResult.pendingIds[0]) as { content_hash: string }
    ).content_hash;
    getDb()
      .prepare(
        `INSERT INTO anki_card_meta (anki_note_id, agent_id, deck, source_type, content_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(123, 'main', 'd', 'text-paste', seedHash, Date.now());
    // Now propose: one duplicate (same content as known) + one new draft
    const llm2 = mockLlm({
      cards: [knownDraft, { model: 'basic', front: 'new q', back: 'new a' }],
    });
    const result = await generateCardsFromText('content', baseOpts({ llm: llm2 }));
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
    expect(result.pendingIds).toHaveLength(1);
  });
});

describe('generateCardsFromText — happy path', () => {
  it('runs the prompt, parses, validates, and proposes a batch', async () => {
    const llm = mockLlm({
      cards: [
        {
          model: 'basic',
          front: 'What is Stayman?',
          back: '2♣ over 1NT asking for a 4-card major',
          tags: ['stayman'],
          source: '§3.3',
        },
        {
          model: 'cloze',
          text: 'Stayman = {{c1::2♣ over 1NT}} asks opener for a major',
          backExtra: 'used with 4-card major + 8+ HCP',
          source: '§3.3',
        },
      ],
    });
    const result = await generateCardsFromText('Some Stayman source content here.', baseOpts({ llm }));
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
    expect(result.pendingIds).toHaveLength(2);
    expect(result.batchId).toMatch(/^batch-/);

    // Verify the rows actually landed in the DB with the right model assignments
    const rows = getDb()
      .prepare(`SELECT id, model, fields_json FROM anki_pending_cards ORDER BY id`)
      .all() as Array<{ id: number; model: string; fields_json: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe('ClaudeClaw Basic Rich');
    expect(rows[1].model).toBe('ClaudeClaw Cloze Rich');
    expect(JSON.parse(rows[0].fields_json)).toEqual({
      Front: 'What is Stayman?',
      Back: '2♣ over 1NT asking for a 4-card major',
      Source: '§3.3',
    });
  });

  it('accepts a bare top-level array when the LLM skips the envelope', async () => {
    const llm = mockLlm([
      { model: 'basic', front: 'q', back: 'a' },
    ]);
    const result = await generateCardsFromText('text', baseOpts({ llm }));
    expect(result.accepted).toHaveLength(1);
  });

  it('assigns content_hash so duplicate drafts produce identical hashes (and the pending-dedup catches re-proposes)', async () => {
    const draft = { model: 'basic', front: 'fixed q', back: 'fixed a' };
    const llm1 = mockLlm({ cards: [draft] });
    const first = await generateCardsFromText('source A', baseOpts({ llm: llm1 }));
    expect(first.accepted).toHaveLength(1);
    // Re-propose same draft from different source text — pending dedup
    // catches it, so we get 0 new rows + 1 duplicate.
    const llm2 = mockLlm({ cards: [draft] });
    const second = await generateCardsFromText('source B', baseOpts({ llm: llm2 }));
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    // Exactly one pending row, with the stable hash
    const rows = getDb()
      .prepare(`SELECT content_hash FROM anki_pending_cards ORDER BY id`)
      .all() as Array<{ content_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('generateCardsFromText — degenerate inputs', () => {
  it('throws on empty source text', async () => {
    const llm = mockLlm({ cards: [] });
    await expect(generateCardsFromText('   \n  ', baseOpts({ llm }))).rejects.toThrow(/empty/);
  });

  it('throws when the LLM returns empty string', async () => {
    const llm = (async () => '') as typeof import('../gemini.js').generateContent;
    await expect(generateCardsFromText('some content', baseOpts({ llm }))).rejects.toThrow(/empty response/);
  });

  it('throws when the LLM returns unparseable JSON', async () => {
    const llm = (async () => 'not really json, sorry') as typeof import('../gemini.js').generateContent;
    await expect(generateCardsFromText('content', baseOpts({ llm }))).rejects.toThrow(/unparseable/);
  });

  it('throws when the LLM returns zero cards', async () => {
    const llm = mockLlm({ cards: [] });
    await expect(generateCardsFromText('content', baseOpts({ llm }))).rejects.toThrow(/zero cards/);
  });

  it('separates valid vs invalid drafts and proposes only the valid ones', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'good q', back: 'good a' },
        { model: 'cloze', text: 'no marker here' }, // invalid — no {{c1::}}
        { model: 'unknown', front: 'bad' }, // invalid model
        { model: 'cloze', text: '{{c1::valid}}' },
      ],
    });
    const result = await generateCardsFromText('content', baseOpts({ llm }));
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].reason).toMatch(/marker/);
    expect(result.rejected[1].reason).toMatch(/model must/);
  });

  it('returns empty pendingIds when all drafts are rejected', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: '', back: 'a' }, // empty front
        { model: 'cloze' }, // no text
      ],
    });
    const result = await generateCardsFromText('content', baseOpts({ llm }));
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.pendingIds).toEqual([]);
    expect(result.batchId).toBeUndefined();
  });
});

describe('sendCardsFromText — Telegram integration', () => {
  it('sends per-card previews FIRST and then the summary (P9 fix)', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'q1', back: 'a1', source: 's1' },
        { model: 'basic', front: 'q2', back: 'a2', source: 's2' },
      ],
    });
    const { ctx, sent } = makeStubCtx();
    await sendCardsFromText(ctx, 'source content', baseOpts({ llm }));
    // Two previews + one summary, in that order
    expect(sent).toHaveLength(3);
    expect(sent[0].text).toContain('Pending card');
    expect(sent[1].text).toContain('Pending card');
    expect(sent[2].text).toMatch(/Drafted 2/);
  });

  it('P9 fix — surfaces per-card preview failures with counts that match reality', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'q1', back: 'a1' },
        { model: 'basic', front: 'q2', back: 'a2' },
        { model: 'basic', front: 'q3', back: 'a3' },
      ],
    });
    const { ctx, sent } = makeStubCtx();
    // Inject a failure on the SECOND ctx.reply that comes from sendPendingPreview's
    // text-fallback path. We track replies and throw on the 2nd preview's reply.
    let previewReplies = 0;
    const origReply = ctx.reply;
    ctx.reply = async (text: string, opts: any) => {
      // Pending-preview text fallback contains "Pending card"
      if (text.includes('Pending card')) {
        previewReplies++;
        if (previewReplies === 2) {
          throw new Error('Telegram rate limited');
        }
      }
      return origReply(text, opts);
    };
    await sendCardsFromText(ctx, 'content', baseOpts({ llm }));
    // The two surviving previews should have been recorded, plus a summary and
    // a "Failed previews" follow-up message.
    const summaryReply = sent.find((s) => /Drafted 3/.test(s.text));
    expect(summaryReply).toBeDefined();
    expect(summaryReply!.text).toMatch(/2 previews delivered/);
    expect(summaryReply!.text).toMatch(/1 preview failed/);
    const failureBreakdown = sent.find((s) => /Failed previews/.test(s.text));
    expect(failureBreakdown).toBeDefined();
  });

  it('reports rejection count when some drafts were malformed', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'q', back: 'a' },
        { model: 'cloze', text: 'no marker' },
      ],
    });
    const { ctx, sent } = makeStubCtx();
    await sendCardsFromText(ctx, 'content', baseOpts({ llm }));
    // Summary is now LAST (after the preview)
    const summary = sent.find((s) => /Drafted/.test(s.text));
    expect(summary).toBeDefined();
    expect(summary!.text).toMatch(/1 drafts rejected/);
  });

  it('reports duplicates as a distinct dimension in the summary', async () => {
    // Pre-seed meta so the next draft is recognized as duplicate
    const draft = { model: 'basic' as const, front: 'dup q', back: 'dup a' };
    const llm1 = mockLlm({ cards: [draft] });
    const firstRun = await generateCardsFromText('seed', baseOpts({ llm: llm1 }));
    const hash = (
      getDb()
        .prepare(`SELECT content_hash FROM anki_pending_cards WHERE id = ?`)
        .get(firstRun.pendingIds[0]) as { content_hash: string }
    ).content_hash;
    getDb()
      .prepare(
        `INSERT INTO anki_card_meta (anki_note_id, agent_id, deck, source_type, content_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(456, 'main', 'd', 'text-paste', hash, Date.now());
    // Now exercise sendCardsFromText with 1 dup + 1 new
    const llm2 = mockLlm({
      cards: [draft, { model: 'basic', front: 'new q', back: 'new a' }],
    });
    const { ctx, sent } = makeStubCtx();
    await sendCardsFromText(ctx, 'content', baseOpts({ llm: llm2 }));
    const summary = sent.find((s) => /Drafted/.test(s.text));
    expect(summary).toBeDefined();
    expect(summary!.text).toMatch(/1 skipped as duplicate/);
  });

  it('special-cases the "all duplicates" message when nothing new survives', async () => {
    const draft = { model: 'basic' as const, front: 'q', back: 'a' };
    const llm1 = mockLlm({ cards: [draft] });
    const firstRun = await generateCardsFromText('seed', baseOpts({ llm: llm1 }));
    const hash = (
      getDb()
        .prepare(`SELECT content_hash FROM anki_pending_cards WHERE id = ?`)
        .get(firstRun.pendingIds[0]) as { content_hash: string }
    ).content_hash;
    getDb()
      .prepare(
        `INSERT INTO anki_card_meta (anki_note_id, agent_id, deck, source_type, content_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(789, 'main', 'd', 'text-paste', hash, Date.now());
    const llm2 = mockLlm({ cards: [draft] });
    const { ctx, sent } = makeStubCtx();
    await sendCardsFromText(ctx, 'content', baseOpts({ llm: llm2 }));
    expect(sent[0].text).toMatch(/already exist in your collection/);
  });

  it('replies with an apology when zero cards land', async () => {
    const llm = mockLlm({ cards: [{ model: 'basic' }] }); // all invalid
    const { ctx, sent } = makeStubCtx();
    await sendCardsFromText(ctx, 'content', baseOpts({ llm }));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/No cards generated/);
  });
});

// ── Story 7: Nano Banana image-gen integration ────────────────────────

describe('generateCardsFromText — image generation', () => {
  it('does not call imageGen for drafts without needsDiagram', async () => {
    const imageGen = vi.fn(async () => Buffer.from('img'));
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'q1', back: 'a1' },
        { model: 'basic', front: 'q2', back: 'a2' },
      ],
    });
    await generateCardsFromText('source', baseOpts({ llm, imageGen }));
    expect(imageGen).not.toHaveBeenCalled();
  });

  it('calls imageGen for each draft with needsDiagram=true and attaches the PNG to media', async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
    const imageGen = vi.fn(async () => fakePng);
    const llm = mockLlm({
      cards: [
        {
          model: 'basic',
          front: 'no-image card',
          back: 'plain',
        },
        {
          model: 'definition',
          term: 'Mitochondrion',
          definition: 'ATP factory',
          needsDiagram: true,
          imagePrompt: 'cross-section of mitochondrion showing cristae',
        },
        {
          model: 'scenario',
          setup: 'You hold a hand',
          question: 'What do you bid?',
          answer: '1NT',
          needsDiagram: true,
          imagePrompt: 'a labeled bridge hand layout',
        },
      ],
    });

    await generateCardsFromText('source', baseOpts({ llm, imageGen }));

    expect(imageGen).toHaveBeenCalledTimes(2);
    expect(imageGen).toHaveBeenCalledWith('cross-section of mitochondrion showing cristae');
    expect(imageGen).toHaveBeenCalledWith('a labeled bridge hand layout');

    // Verify PNGs landed in the pending rows' media
    const rows = getDb()
      .prepare(`SELECT id, model, fields_json, media_json FROM anki_pending_cards ORDER BY id`)
      .all() as Array<{ id: number; model: string; fields_json: string; media_json: string | null }>;
    expect(rows).toHaveLength(3);

    // Card 1 (basic, no diagram) → no media
    expect(rows[0].media_json).toBeNull();

    // Card 2 (definition) → has media, <img> prepended to Definition field
    expect(rows[1].media_json).not.toBeNull();
    const media1 = JSON.parse(rows[1].media_json!);
    expect(media1).toHaveLength(1);
    expect(media1[0].filename).toMatch(/^claudeclaw-.*\.png$/);
    const fields1 = JSON.parse(rows[1].fields_json);
    expect(fields1.Definition).toContain(`<img src="${media1[0].filename}"`);
    expect(fields1.Definition).toContain('ATP factory');

    // Card 3 (scenario) → has media, <img> prepended to Answer
    expect(rows[2].media_json).not.toBeNull();
    const media2 = JSON.parse(rows[2].media_json!);
    expect(media2).toHaveLength(1);
    const fields2 = JSON.parse(rows[2].fields_json);
    expect(fields2.Answer).toContain(`<img src="${media2[0].filename}"`);
    expect(fields2.Answer).toContain('1NT');
  });

  it('honors maxImages cap — first N flagged drafts get images, rest go without', async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const imageGen = vi.fn(async () => fakePng);
    const llm = mockLlm({
      cards: Array.from({ length: 5 }, (_, i) => ({
        model: 'basic',
        front: `q${i}`,
        back: `a${i}`,
        needsDiagram: true,
        imagePrompt: `prompt ${i}`,
      })),
    });
    await generateCardsFromText('source', baseOpts({ llm, imageGen, maxImages: 2 }));
    expect(imageGen).toHaveBeenCalledTimes(2);
    // imageGen was called with the first two prompts in order
    expect(imageGen).toHaveBeenNthCalledWith(1, 'prompt 0');
    expect(imageGen).toHaveBeenNthCalledWith(2, 'prompt 1');
    // First two pending rows have media; last three don't (order matters)
    const rows = getDb()
      .prepare(`SELECT media_json FROM anki_pending_cards ORDER BY id`)
      .all() as Array<{ media_json: string | null }>;
    expect(rows).toHaveLength(5);
    expect(rows[0].media_json).not.toBeNull();
    expect(rows[1].media_json).not.toBeNull();
    expect(rows[2].media_json).toBeNull();
    expect(rows[3].media_json).toBeNull();
    expect(rows[4].media_json).toBeNull();
  });

  it('continues without image when imageGen returns null (graceful)', async () => {
    const imageGen = vi.fn(async () => null);
    const llm = mockLlm({
      cards: [
        {
          model: 'basic',
          front: 'q',
          back: 'a',
          needsDiagram: true,
          imagePrompt: 'something',
        },
      ],
    });
    const result = await generateCardsFromText('source', baseOpts({ llm, imageGen }));
    expect(result.accepted).toHaveLength(1);
    expect(result.pendingIds).toHaveLength(1);
    const row = getDb()
      .prepare(`SELECT media_json, fields_json FROM anki_pending_cards`)
      .get() as { media_json: string | null; fields_json: string };
    expect(row.media_json).toBeNull();
    // Field should NOT contain an <img> tag
    const fields = JSON.parse(row.fields_json);
    expect(fields.Back).not.toContain('<img');
  });

  it('continues without image when imageGen throws', async () => {
    const imageGen = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const llm = mockLlm({
      cards: [
        {
          model: 'basic',
          front: 'q',
          back: 'a',
          needsDiagram: true,
          imagePrompt: 'something',
        },
      ],
    });
    const result = await generateCardsFromText('source', baseOpts({ llm, imageGen }));
    expect(result.accepted).toHaveLength(1);
  });
});
