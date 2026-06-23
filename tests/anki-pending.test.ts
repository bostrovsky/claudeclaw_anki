import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock canvas-render so tests don't spawn Playwright.
// Returning null exercises the text-fallback preview path; replyWithPhoto isn't hit.
vi.mock('./canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

import { _initTestDatabase, getDb } from './db.js';
import {
  _clearStockModelCacheForTests,
  _setCoreForTests,
  approvePending,
  ensureStockModelsLoaded,
  getPendingCard,
  listPendingByAgent,
  listPendingByBatch,
  proposePendingBatch,
  proposePendingCard,
  rejectPending,
  renderPendingPreviewHtml,
  sendPendingPreview,
  updatePendingFields,
} from './anki-pending.js';
import type { AnkiCore } from './anki-mcp-core.js';

interface RecordedCall {
  action: string;
  params: Record<string, unknown>;
}

function makeStubCore(scripted: Array<[string, unknown]>): { core: AnkiCore; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const ankiCall = async <T>(action: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ action, params: params ?? {} });
    if (cursor >= scripted.length) {
      throw new Error(`Unexpected ankiCall(${action}) — no scripted response`);
    }
    const [expectedAction, value] = scripted[cursor];
    if (expectedAction !== action) {
      throw new Error(`Scripted mismatch: queue had ${expectedAction}, got ${action}`);
    }
    cursor++;
    return value as T;
  };
  const ensureProfile = async (_profile: string): Promise<void> => {
    // No-op for tests; profile-switch is tested in anki-mcp-core.test.ts
  };
  const syncSafe = async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true });
  const withProfileLock = async <T>(fn: () => Promise<T>): Promise<T> => fn();
  const validateImportPath = (): void => {};
  const core: AnkiCore = {
    ankiCall: ankiCall as AnkiCore['ankiCall'],
    ensureProfile,
    syncSafe,
    withProfileLock,
    validateImportPath,
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
  return { core, calls };
}

function makeStubCtx(): { ctx: any; sent: any[] } {
  const sent: any[] = [];
  const ctx = {
    reply: vi.fn(async (text: string, opts?: any) => {
      sent.push({ kind: 'text', text, opts });
      return { message_id: 999 };
    }),
    replyWithPhoto: vi.fn(async (file: any, opts?: any) => {
      sent.push({ kind: 'photo', file, opts });
      return { message_id: 1000 };
    }),
    answerCallbackQuery: vi.fn(async () => {}),
  };
  return { ctx, sent };
}

beforeEach(() => {
  _initTestDatabase();
  _setCoreForTests(null);
  _clearStockModelCacheForTests();
});

// ── proposePendingCard ────────────────────────────────────────────────

describe('proposePendingCard', () => {
  it('inserts a pending row and returns the hydrated card', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Test',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'What is Stayman?', Back: '2C over 1NT' },
      tags: ['bridge', 'stayman'],
      sourceType: 'manual',
      sourceCitation: 'Telegram /newcard',
    });
    expect(card.id).toBeGreaterThan(0);
    expect(card.status).toBe('pending');
    expect(card.tags).toEqual(['bridge', 'stayman']);
    expect(card.fields).toEqual({ Front: 'What is Stayman?', Back: '2C over 1NT' });
    expect(card.proposedAt).toBeGreaterThan(0);
    expect(card.batchId).toBeNull();

    const row = getDb()
      .prepare(`SELECT * FROM anki_pending_cards WHERE id = ?`)
      .get(card.id) as { fields_json: string; status: string };
    expect(JSON.parse(row.fields_json)).toEqual(card.fields);
    expect(row.status).toBe('pending');
  });

  it('persists media as JSON-encoded array', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'm',
      fields: { Front: 'f' },
      sourceType: 'manual',
      media: [{ filename: 'a.png', data: 'aGVsbG8=' }],
    });
    expect(card.media).toEqual([{ filename: 'a.png', data: 'aGVsbG8=' }]);
  });
});

describe('proposePendingBatch', () => {
  it('assigns a shared batch_id and inserts inside a transaction', () => {
    const { batchId, cards } = proposePendingBatch([
      { agentId: 'main', deck: 'D', model: 'M', fields: { Front: 'a' }, sourceType: 'manual' },
      { agentId: 'main', deck: 'D', model: 'M', fields: { Front: 'b' }, sourceType: 'manual' },
      { agentId: 'main', deck: 'D', model: 'M', fields: { Front: 'c' }, sourceType: 'manual' },
    ]);
    expect(cards).toHaveLength(3);
    expect(batchId).toMatch(/^batch-/);
    expect(cards.every((c) => c.batchId === batchId)).toBe(true);
    const fetched = listPendingByBatch(batchId);
    expect(fetched).toHaveLength(3);
    expect(fetched.map((c) => c.fields.Front)).toEqual(['a', 'b', 'c']);
  });

  it('respects an explicitly provided batchId from the first input', () => {
    const { batchId } = proposePendingBatch([
      {
        agentId: 'main',
        deck: 'D',
        model: 'M',
        fields: { Front: 'a' },
        sourceType: 'manual',
        batchId: 'fixed-batch-123',
      },
      { agentId: 'main', deck: 'D', model: 'M', fields: { Front: 'b' }, sourceType: 'manual' },
    ]);
    expect(batchId).toBe('fixed-batch-123');
  });
});

// ── update / reject / list ────────────────────────────────────────────

describe('updatePendingFields', () => {
  it('merges new field values and flips status to edited', () => {
    const c = proposePendingCard({
      agentId: 'main',
      deck: 'D',
      model: 'M',
      fields: { Front: 'old', Back: 'unchanged' },
      sourceType: 'manual',
    });
    const updated = updatePendingFields(c.id, { Front: 'new' });
    expect(updated?.fields).toEqual({ Front: 'new', Back: 'unchanged' });
    expect(updated?.status).toBe('edited');
  });

  it('returns null when card does not exist', () => {
    expect(updatePendingFields(999, { Front: 'x' })).toBeNull();
  });
});

describe('rejectPending', () => {
  it('marks status rejected and is idempotent on a second call', () => {
    const c = proposePendingCard({
      agentId: 'main',
      deck: 'D',
      model: 'M',
      fields: { Front: 'q' },
      sourceType: 'manual',
    });
    const r1 = rejectPending(c.id);
    expect(r1?.status).toBe('rejected');
    const r2 = rejectPending(c.id);
    expect(r2?.status).toBe('rejected');
  });

  it('returns null for non-existent cards', () => {
    expect(rejectPending(12345)).toBeNull();
  });
});

describe('updatePendingFields — terminal-status guard (P5 fix)', () => {
  it('refuses edits to approved cards (would otherwise duplicate Anki notes on re-approve)', async () => {
    const { core } = makeStubCore([
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']],
      ['createDeck', 1],
      ['addNote', 42],
      ['sync', null],
    ]);
    _setCoreForTests(core);
    const c = proposePendingCard({
      agentId: 'main',
      deck: 'D',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      sourceType: 'manual',
    });
    await approvePending(c.id);
    expect(() => updatePendingFields(c.id, { Front: 'changed' })).toThrow(/is approved.*cannot edit/);
  });

  it('refuses edits to rejected cards', () => {
    const c = proposePendingCard({
      agentId: 'main',
      deck: 'D',
      model: 'M',
      fields: { Front: 'q' },
      sourceType: 'manual',
    });
    rejectPending(c.id);
    expect(() => updatePendingFields(c.id, { Front: 'x' })).toThrow(/is rejected.*cannot edit/);
  });
});

describe('proposePendingCard — media size cap (P9 fix)', () => {
  it('rejects total media payload over the cap', () => {
    const huge = 'a'.repeat(11_000_000);
    expect(() =>
      proposePendingCard({
        agentId: 'main',
        deck: 'd',
        model: 'm',
        fields: { Front: 'f' },
        sourceType: 'manual',
        media: [{ filename: 'big.png', data: huge }],
      }),
    ).toThrow(/too large/);
  });

  it('rejects when total across many files exceeds the cap', () => {
    const fifthSize = 'a'.repeat(3_000_000);
    expect(() =>
      proposePendingCard({
        agentId: 'main',
        deck: 'd',
        model: 'm',
        fields: { Front: 'f' },
        sourceType: 'manual',
        media: [
          { filename: 'a.png', data: fifthSize },
          { filename: 'b.png', data: fifthSize },
          { filename: 'c.png', data: fifthSize },
          { filename: 'd.png', data: fifthSize },
        ],
      }),
    ).toThrow(/too large/);
  });
});

describe('listPendingByAgent', () => {
  it('returns only pending cards for the given agent, ordered oldest-first', () => {
    proposePendingCard({ agentId: 'a1', deck: 'd', model: 'm', fields: { Front: 'a1-card' }, sourceType: 'manual' });
    const middle = proposePendingCard({
      agentId: 'a1',
      deck: 'd',
      model: 'm',
      fields: { Front: 'a1-card-2' },
      sourceType: 'manual',
    });
    proposePendingCard({ agentId: 'a2', deck: 'd', model: 'm', fields: { Front: 'a2-card' }, sourceType: 'manual' });
    rejectPending(middle.id);
    const a1 = listPendingByAgent('a1');
    expect(a1).toHaveLength(1);
    expect(a1[0].fields.Front).toBe('a1-card');
  });
});

// ── approvePending ────────────────────────────────────────────────────

describe('approvePending', () => {
  it('loads stock models, ensures deck, calls addNote, writes anki_card_meta, marks approved', async () => {
    const { core, calls } = makeStubCore([
      // ensureStockModelsLoaded: modelNames check, then createModel for any missing
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']], // both present → no createModel
      // approvePending body: createDeck + addNote + sync
      ['createDeck', 1234567890],
      ['addNote', 9988776655],
      ['sync', null],
    ]);
    _setCoreForTests(core);

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Conventions::Stayman',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      tags: ['stayman'],
      sourceType: 'youtube',
      sourceRef: 'https://example.com/v',
      sourceCitation: 'Foo Lecture @ 2:35',
      contentHash: 'abc123',
    });

    const result = await approvePending(card.id);
    expect(result.ankiNoteId).toBe(9988776655);
    expect(result.syncOk).toBe(true);

    expect(calls.map((c) => c.action)).toEqual(['modelNames', 'createDeck', 'addNote', 'sync']);
    expect(calls[1].params).toEqual({ deck: 'Bridge::Conventions::Stayman' });
    // P8 fix: auto-applied source:<sourceType> tag appended.
    expect(calls[2].params).toMatchObject({
      note: {
        deckName: 'Bridge::Conventions::Stayman',
        modelName: 'ClaudeClaw Basic Rich',
        fields: { Front: 'q', Back: 'a' },
        tags: ['stayman', 'source:youtube'],
      },
    });

    // anki_card_meta row written
    const meta = getDb()
      .prepare(`SELECT * FROM anki_card_meta WHERE anki_note_id = ?`)
      .get(9988776655) as Record<string, unknown>;
    expect(meta.agent_id).toBe('main');
    expect(meta.deck).toBe('Bridge::Conventions::Stayman');
    expect(meta.source_type).toBe('youtube');
    expect(meta.source_ref).toBe('https://example.com/v');
    expect(meta.source_citation).toBe('Foo Lecture @ 2:35');
    expect(meta.content_hash).toBe('abc123');

    // Pending row marked approved with the anki_note_id
    const after = getPendingCard(card.id);
    expect(after?.status).toBe('approved');
    expect(after?.ankiNoteId).toBe(9988776655);
    expect(after?.decidedAt).toBeGreaterThan(0);
  });

  it('createModel fires for missing stock models on first use per profile', async () => {
    const { core, calls } = makeStubCore([
      // ensureStockModelsLoaded — none present, all five archetypes need creation
      ['modelNames', []],
      ['createModel', 1],
      ['createModel', 2],
      ['createModel', 3],
      ['createModel', 4],
      ['createModel', 5],
      // approval flow
      ['createDeck', 9],
      ['addNote', 100],
      ['sync', null],
    ]);
    _setCoreForTests(core);

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'f', Back: 'b' },
      sourceType: 'manual',
    });
    const result = await approvePending(card.id);
    expect(result.ankiNoteId).toBe(100);
    expect(calls.filter((c) => c.action === 'createModel').length).toBe(5);
  });

  it('uploads media before addNote when card has media attached', async () => {
    const { core, calls } = makeStubCore([
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']],
      ['storeMediaFile', 'a.png'],
      ['createDeck', 1],
      ['addNote', 42],
      ['sync', null],
    ]);
    _setCoreForTests(core);

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: '<img src="a.png">', Back: 'b' },
      sourceType: 'manual',
      media: [{ filename: 'a.png', data: 'aGVsbG8=' }],
    });
    const result = await approvePending(card.id);
    expect(result.ankiNoteId).toBe(42);
    const storeIdx = calls.findIndex((c) => c.action === 'storeMediaFile');
    const noteIdx = calls.findIndex((c) => c.action === 'addNote');
    expect(storeIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(storeIdx); // media uploaded BEFORE the note
  });

  it('captures sync failure as syncOk=false but does NOT roll back the approve', async () => {
    // P17 fix: previous version scripted a 4th 'sync' entry that was unreachable
    // because we override ankiCall to throw on 'sync'. Drop the dead scripted
    // entry and verify the queue is fully consumed by the path that runs.
    const { core } = makeStubCore([
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']],
      ['createDeck', 1],
      ['addNote', 200],
      // intentionally no 'sync' scripted — wrap overrides it to throw
    ]);
    _setCoreForTests(core);

    const original = core.ankiCall;
    core.ankiCall = (async <T>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
      if (action === 'sync') throw new Error('AnkiWeb offline');
      return original(action, params, timeoutMs) as Promise<T>;
    }) as AnkiCore['ankiCall'];

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'f', Back: 'b' },
      sourceType: 'manual',
    });
    const result = await approvePending(card.id);
    expect(result.ankiNoteId).toBe(200);
    expect(result.syncOk).toBe(false);
    expect(result.syncError).toMatch(/AnkiWeb offline/);
    // Still marked approved
    expect(getPendingCard(card.id)?.status).toBe('approved');
  });

  // P2 fix coverage — atomic claim prevents concurrent double-approve.
  it('refuses a second approve when the row was already claimed by an earlier call', async () => {
    const { core } = makeStubCore([
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']],
      ['createDeck', 1],
      ['addNote', 555],
      ['sync', null],
    ]);
    _setCoreForTests(core);
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      sourceType: 'manual',
    });
    // First approve succeeds.
    await approvePending(card.id);
    // Second attempt — status is now 'approved', the conditional UPDATE
    // changes 0 rows, approvePending throws without touching AnkiConnect.
    await expect(approvePending(card.id)).rejects.toThrow(/is approved.*cannot approve/);
  });

  // P2 fix coverage — revert mechanism if AnkiConnect fails after we claim.
  it('reverts status from approving back to original when addNote throws', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.action === 'getActiveProfile') {
        return new Response(JSON.stringify({ result: 'Brian', error: null }), { status: 200 });
      }
      if (body.action === 'modelNames') {
        return new Response(
          JSON.stringify({
            result: [
              'ClaudeClaw Basic Rich',
              'ClaudeClaw Cloze Rich',
              'ClaudeClaw Definition',
              'ClaudeClaw Scenario',
              'ClaudeClaw Comparison',
            ],
            error: null,
          }),
          { status: 200 },
        );
      }
      if (body.action === 'createDeck') {
        return new Response(JSON.stringify({ result: 1, error: null }), { status: 200 });
      }
      if (body.action === 'addNote') {
        return new Response(JSON.stringify({ result: null, error: 'deck was not found' }), { status: 200 });
      }
      throw new Error(`Unexpected: ${body.action}`);
    };
    // Construct a core wrapping our fetch
    const realCore = (await import('./anki-mcp-core.js')).createCore({
      ankiConnectUrl: 'http://test',
      defaultProfile: 'Brian',
      fetchFn,
    });
    _setCoreForTests(realCore);

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      sourceType: 'manual',
    });
    await expect(approvePending(card.id)).rejects.toThrow(/deck was not found/);
    // Status reverted to original (pending), not stuck on 'approving'.
    expect(getPendingCard(card.id)?.status).toBe('pending');
  });

  // P18 — coverage for ensureProfile failure path.
  it('reverts claim and propagates when ensureProfile fails', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.action === 'getActiveProfile') {
        return new Response(JSON.stringify({ result: 'WrongProfile', error: null }), { status: 200 });
      }
      if (body.action === 'modelNames') {
        return new Response(
          JSON.stringify({ result: ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich'], error: null }),
          { status: 200 },
        );
      }
      if (body.action === 'loadProfile') {
        return new Response(JSON.stringify({ result: null, error: null }), { status: 200 });
      }
      throw new Error(`Unexpected: ${body.action}`);
    };
    // After loadProfile, ensureProfile re-queries getActiveProfile and the stub
    // keeps returning 'WrongProfile' → ensureProfile throws (M6 verification).
    const realCore = (await import('./anki-mcp-core.js')).createCore({
      ankiConnectUrl: 'http://test',
      defaultProfile: 'Brian',
      fetchFn,
    });
    _setCoreForTests(realCore);

    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      sourceType: 'manual',
    });
    await expect(approvePending(card.id)).rejects.toThrow(/did not switch/);
    expect(getPendingCard(card.id)?.status).toBe('pending');
  });

  // P10 fix coverage — the cache prevents repeat modelNames probes per profile.
  it('does not re-issue modelNames on the second approve for the same profile', async () => {
    const { core, calls } = makeStubCore([
      ['modelNames', ['ClaudeClaw Basic Rich', 'ClaudeClaw Cloze Rich', 'ClaudeClaw Definition', 'ClaudeClaw Scenario', 'ClaudeClaw Comparison']],
      ['createDeck', 1],
      ['addNote', 1],
      ['sync', null],
      // SECOND approve — note: no modelNames here, cache should skip it
      ['createDeck', 2],
      ['addNote', 2],
      ['sync', null],
    ]);
    _setCoreForTests(core);
    const a = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'a', Back: 'b' },
      sourceType: 'manual',
    });
    const b = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'c', Back: 'd' },
      sourceType: 'manual',
    });
    await approvePending(a.id);
    await approvePending(b.id);
    const modelNamesCount = calls.filter((c) => c.action === 'modelNames').length;
    expect(modelNamesCount).toBe(1);
  });

  it('returns a clear error when card is missing', async () => {
    // P2 already-claimed path is covered by the dedicated test above.
    await expect(approvePending(99999)).rejects.toThrow(/not found/);
  });

});

// ── ensureStockModelsLoaded ───────────────────────────────────────────

describe('ensureStockModelsLoaded', () => {
  it('reports which models were created vs already present', async () => {
    const { core } = makeStubCore([
      // Only basic present; cloze + 3 new archetypes missing
      ['modelNames', ['ClaudeClaw Basic Rich']],
      ['createModel', 1],
      ['createModel', 2],
      ['createModel', 3],
      ['createModel', 4],
    ]);
    _setCoreForTests(core);
    const result = await ensureStockModelsLoaded('Brian');
    expect(result.existing).toContain('ClaudeClaw Basic Rich');
    expect(result.created).toEqual(
      expect.arrayContaining([
        'ClaudeClaw Cloze Rich',
        'ClaudeClaw Definition',
        'ClaudeClaw Scenario',
        'ClaudeClaw Comparison',
      ]),
    );
  });
});

// ── renderPendingPreviewHtml ──────────────────────────────────────────

describe('renderPendingPreviewHtml', () => {
  it('produces self-contained HTML with the card fields visible', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Stayman',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'When does responder use Stayman?', Back: '4-card major + 8+ HCP', Source: 'Coach Dave' },
      tags: ['bridge'],
      sourceType: 'doc-html',
      sourceRef: '/tmp/dave-bidding-system.html',
      sourceCitation: 'KB-BP-103',
    });
    const html = renderPendingPreviewHtml(card, { index: 1, total: 3 });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Card 1 of 3');
    expect(html).toContain('Bridge::Stayman');
    expect(html).toContain('When does responder use Stayman?');
    expect(html).toContain('4-card major + 8+ HCP');
    expect(html).toContain('ClaudeClaw Basic Rich');
    expect(html).toContain('doc-html');
  });

  it('handles cloze-style cards (Text field instead of Front/Back) — emits Question + Answer blocks', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Cloze Rich',
      fields: { Text: 'Stayman = {{c1::2♣ over 1NT}}', BackExtra: 'asks opener for a 4-card major' },
      sourceType: 'manual',
    });
    const html = renderPendingPreviewHtml(card);
    // Cloze syntax is fully consumed
    expect(html).not.toContain('{{c1::');
    // Question block uses blanks so the preview reads as an actual flashcard
    expect(html).toContain('>Question<');
    expect(html).toContain('cloze-blank');
    expect(html).toContain('[ ___1___ ]');
    // Answer block reveals the answers as styled cloze pills
    expect(html).toContain('Answer (revealed)');
    expect(html).toContain('<span class="cloze">2♣ over 1NT</span>');
    // BackExtra is still rendered separately
    expect(html).toContain('asks opener');
    expect(html).toContain('>Extra<');
    expect(html).not.toContain('(no back)');
  });

  it('handles cloze-style cards without BackExtra — omits the extra section entirely', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Cloze Rich',
      fields: { Text: 'Stayman = {{c1::2♣ over 1NT}}' },
      sourceType: 'manual',
    });
    const html = renderPendingPreviewHtml(card);
    expect(html).not.toContain('(no back)');
    expect(html).not.toContain('>Extra<'); // no extra label when BackExtra is absent
  });

  it('renders Definition archetype with Term / Definition / Example blocks', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Glossary',
      model: 'ClaudeClaw Definition',
      fields: {
        Term: 'Stayman',
        Definition: '2♣ over 1NT asking for a 4-card major',
        Example: 'With ♠KQxx ♥xx ♦Kxx ♣Jxxx, respond 2♣',
        Source: 'Coach Dave',
      },
      sourceType: 'doc-html',
    });
    const html = renderPendingPreviewHtml(card);
    expect(html).toContain('>Term<');
    expect(html).toContain('>Definition<');
    expect(html).toContain('>Example<');
    expect(html).toContain('Stayman');
    expect(html).toContain('4-card major');
    expect(html).toContain('KQxx');
  });

  it('renders Scenario archetype with Setup / Question / Answer / Why blocks', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Auctions',
      model: 'ClaudeClaw Scenario',
      fields: {
        Setup: 'Partner opens 1NT (15-17). You hold ♠KQxx ♥xx ♦Kxx ♣Jxxx.',
        Question: 'What is your bid?',
        Answer: '2♣ (Stayman)',
        Why: 'Finding a 4-4 spade fit before committing to NT.',
        Source: 'KB-BP-021',
      },
      sourceType: 'doc-dave-kb',
    });
    const html = renderPendingPreviewHtml(card);
    expect(html).toContain('>Setup<');
    expect(html).toContain('>Question<');
    expect(html).toContain('>Answer<');
    expect(html).toContain('>Why<');
    expect(html).toContain('KQxx');
    expect(html).toContain('2♣ (Stayman)');
    expect(html).toContain('4-4 spade fit');
  });

  it('inlines auto-diagram media as data: URLs so Canvas preview can render the image', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Anatomy::Brain',
      model: 'ClaudeClaw Definition',
      fields: {
        Term: 'Axon',
        Definition: '<img src="claudeclaw-test-0.png" class="auto-diagram">\nA long projection.',
        Example: '',
        Source: 'Lehninger',
      },
      sourceType: 'doc-html',
      media: [{ filename: 'claudeclaw-test-0.png', data: 'AAAAAAAA' }],
    });
    const html = renderPendingPreviewHtml(card);
    // Bare filename has been replaced with an inline data: URL
    expect(html).not.toContain('src="claudeclaw-test-0.png"');
    expect(html).toContain('src="data:image/png;base64,AAAAAAAA"');
    // The auto-diagram class survives
    expect(html).toContain('class="auto-diagram"');
  });

  it('leaves unknown <img src> values alone (defensive — surfaces as broken image rather than crash)', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: '<img src="orphan.png"> answer' },
      sourceType: 'manual',
      // no media attached — orphan reference
    });
    const html = renderPendingPreviewHtml(card);
    expect(html).toContain('src="orphan.png"');
    expect(html).not.toContain('data:image');
  });

  it('renders Comparison archetype with A / B / Difference blocks', () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'Bridge::Conventions',
      model: 'ClaudeClaw Comparison',
      fields: {
        ConceptA: 'Stayman (2♣ over 1NT)',
        ConceptB: 'Jacoby Transfer (2♦/2♥ over 1NT)',
        Difference: 'Stayman asks for a 4-card major; Jacoby commands a transfer.',
        Source: 'Coach Dave',
      },
      sourceType: 'doc-html',
    });
    const html = renderPendingPreviewHtml(card);
    expect(html).toContain('>A<');
    expect(html).toContain('>B<');
    expect(html).toContain('>Difference<');
    expect(html).toContain('Stayman (2♣ over 1NT)');
    expect(html).toContain('Jacoby Transfer');
    expect(html).toContain('commands a transfer');
  });
});

// ── sendPendingPreview (text-fallback path) ───────────────────────────

describe('sendPendingPreview', () => {
  it('falls back to text preview with inline keyboard when canvas-render returns null', async () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'ClaudeClaw Basic Rich',
      fields: { Front: 'q', Back: 'a' },
      sourceType: 'manual',
      sourceCitation: 'Test',
    });
    const { ctx, sent } = makeStubCtx();
    await sendPendingPreview(ctx, card);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('text');
    expect(sent[0].text).toContain('Pending card');
    // Inline keyboard attached
    expect(sent[0].opts?.reply_markup).toBeDefined();
    // preview_message_id persisted on the row
    expect(getPendingCard(card.id)?.previewMessageId).toBe(999);
  });

  it('includes "Approve all" button only when batch has >1 pending', async () => {
    const { batchId } = proposePendingBatch([
      { agentId: 'main', deck: 'd', model: 'm', fields: { Front: '1' }, sourceType: 'manual' },
      { agentId: 'main', deck: 'd', model: 'm', fields: { Front: '2' }, sourceType: 'manual' },
    ]);
    const cards = listPendingByBatch(batchId);
    const { ctx, sent } = makeStubCtx();
    await sendPendingPreview(ctx, cards[0]);
    const keyboard = sent[0].opts?.reply_markup;
    const buttonTexts = JSON.stringify(keyboard);
    expect(buttonTexts).toContain('Approve all 2');
  });

  it('does NOT include "Approve all" button for a singleton card', async () => {
    const card = proposePendingCard({
      agentId: 'main',
      deck: 'd',
      model: 'm',
      fields: { Front: 'f' },
      sourceType: 'manual',
    });
    const { ctx, sent } = makeStubCtx();
    await sendPendingPreview(ctx, card);
    const keyboard = sent[0].opts?.reply_markup;
    const buttonTexts = JSON.stringify(keyboard);
    expect(buttonTexts).not.toContain('Approve all');
  });
});
