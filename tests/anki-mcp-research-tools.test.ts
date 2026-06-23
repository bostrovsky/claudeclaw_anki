/**
 * Story 9: anki_propose_cards_from_text and anki_auto_import_text MCP tools.
 *
 * These wrap generateCardsFromText (and for auto-import, approvePending).
 * The Gemini LLM is mocked via vi.mock so the test is deterministic.
 * Canvas is mocked because it's not relevant to the MCP response shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

// Mock generateContent to return deterministic card JSON for these tests.
// Each test sets the response payload via _setMockedCards before dispatching.
let _mockedCards: unknown[] = [];
vi.mock('./gemini.js', async () => {
  const actual = await vi.importActual<typeof import('./gemini.js')>('./gemini.js');
  return {
    ...actual,
    generateContent: vi.fn(async () => JSON.stringify({ cards: _mockedCards })),
  };
});

function _setMockedCards(cards: unknown[]): void {
  _mockedCards = cards;
}

import { _initTestDatabase, getDb } from './db.js';
import { createCore, dispatchTool, type AnkiCoreConfig } from './anki-mcp-core.js';
import { _setCoreForTests as _setPendingCore, _clearStockModelCacheForTests } from './anki-pending.js';

interface FetchCall {
  action: string;
  params: Record<string, unknown>;
}

function makeFetchStub(responses: Array<[string, unknown]>) {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    calls.push({ action: body.action, params: body.params ?? {} });
    if (cursor >= responses.length) {
      throw new Error(`Unexpected AnkiConnect call: ${body.action}`);
    }
    const [expected, result] = responses[cursor];
    if (expected !== body.action) {
      throw new Error(`Expected ${expected}, got ${body.action}`);
    }
    cursor++;
    return new Response(JSON.stringify({ result, error: null }), { status: 200 });
  };
  return { fetchFn, calls };
}

const baseConfig = (overrides?: Partial<AnkiCoreConfig>): AnkiCoreConfig => ({
  ankiConnectUrl: 'http://stub',
  defaultProfile: 'Brian',
  ...overrides,
});

beforeEach(() => {
  _initTestDatabase();
  _clearStockModelCacheForTests();
  _mockedCards = [];
  // Default core has a no-op fetchFn for the pending module
  const core = createCore(baseConfig({ fetchFn: async () => new Response(JSON.stringify({ result: null, error: null })) }));
  _setPendingCore(core);
});

describe('anki_propose_cards_from_text', () => {
  it('returns proposed/duplicates/rejected counts and pendingIds', async () => {
    _setMockedCards([
      { model: 'basic', front: 'q1', back: 'a1' },
      { model: 'basic', front: 'q2', back: 'a2' },
    ]);
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'Test::Deck',
      sourceText: 'Some research synthesis about photosynthesis.',
      sourceLabel: 'Khan Academy + Lehninger',
      agentId: 'research',
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.proposed).toBe(2);
    expect(body.pendingIds).toHaveLength(2);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toBe(0);
    expect(body.batchId).toMatch(/^batch-/);

    // Verify the pending rows landed
    const rows = getDb()
      .prepare(`SELECT agent_id, deck, source_type, source_citation FROM anki_pending_cards ORDER BY id`)
      .all() as Array<{ agent_id: string; deck: string; source_type: string; source_citation: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_id).toBe('research');
    expect(rows[0].deck).toBe('Test::Deck');
    expect(rows[0].source_type).toBe('agent-research');
  });

  it('uses the supplied sourceType and topicHint', async () => {
    _setMockedCards([{ model: 'basic', front: 'q', back: 'a' }]);
    const core = createCore(baseConfig());
    const result = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'Bio::Cell',
      sourceText: 'Mitochondria are the powerhouse of the cell.',
      sourceLabel: 'High school bio',
      sourceType: 'lecture-notes',
      topicHint: 'organelles',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.proposed).toBe(1);
    const row = getDb()
      .prepare(`SELECT source_type FROM anki_pending_cards`)
      .get() as { source_type: string };
    expect(row.source_type).toBe('lecture-notes');
  });

  it('returns an error when sourceText is empty', async () => {
    const core = createCore(baseConfig());
    const result = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd',
      sourceText: '   ',
      sourceLabel: 'whatever',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sourceText is required/);
  });

  it('returns an error when deck is missing', async () => {
    const core = createCore(baseConfig());
    const result = await dispatchTool(core, 'anki_propose_cards_from_text', {
      sourceText: 'x',
      sourceLabel: 'y',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/deck is required/);
  });

  it('returns an error when sourceLabel is missing', async () => {
    const core = createCore(baseConfig());
    const result = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd',
      sourceText: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/sourceLabel is required/);
  });
});

/**
 * Permissive AnkiConnect fetch stub for auto-import tests. Returns
 * plausible success responses for any recognized action; doesn't care
 * about call order. Lets us assert business-logic outcomes (imported
 * count, note IDs, DB status) without coupling to the internal call
 * sequence of approvePending and ensureStockModelsLoaded.
 */
function makePermissiveFetch(opts: {
  noteIdsToReturn: number[];
  failAddNoteWhere?: (note: { fields?: Record<string, string> }) => boolean;
}): typeof fetch {
  let addNoteCursor = 0;
  return async (_input, init) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const action = body.action;
    let result: unknown = null;
    let error: string | null = null;
    if (action === 'getActiveProfile') result = 'Brian';
    else if (action === 'modelNames')
      result = [
        'ClaudeClaw Basic Rich',
        'ClaudeClaw Cloze Rich',
        'ClaudeClaw Definition',
        'ClaudeClaw Scenario',
        'ClaudeClaw Comparison',
      ];
    else if (action === 'createDeck') result = 1;
    else if (action === 'sync') result = null;
    else if (action === 'addNote') {
      const note = (body.params?.note ?? {}) as { fields?: Record<string, string> };
      if (opts.failAddNoteWhere && opts.failAddNoteWhere(note)) {
        result = null;
        error = 'addNote failed';
      } else if (addNoteCursor < opts.noteIdsToReturn.length) {
        result = opts.noteIdsToReturn[addNoteCursor++];
      } else {
        result = null;
        error = 'no more scripted noteIds';
      }
    } else {
      // Unknown action — return null and let the test fail naturally
      result = null;
    }
    return new Response(JSON.stringify({ result, error }), { status: 200 });
  };
}

describe('anki_auto_import_text', () => {
  it('proposes, approves each card, and returns Anki note IDs', async () => {
    _setMockedCards([
      { model: 'basic', front: 'qA', back: 'aA' },
      { model: 'basic', front: 'qB', back: 'aB' },
    ]);
    const fetchFn = makePermissiveFetch({ noteIdsToReturn: [100, 101] });
    const core = createCore(baseConfig({ fetchFn }));
    _setPendingCore(core);

    const result = await dispatchTool(core, 'anki_auto_import_text', {
      deck: 'Auto::Test',
      sourceText: 'research content',
      sourceLabel: 'Test source',
      agentId: 'research',
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.imported).toBe(2);
    expect(body.ankiNoteIds).toEqual([100, 101]);
    expect(body.failed).toBe(0);

    // Pending rows are all approved
    const rows = getDb()
      .prepare(`SELECT status FROM anki_pending_cards`)
      .all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved']);
  });

  it('continues importing when one card fails to approve', async () => {
    _setMockedCards([
      { model: 'basic', front: 'qOK', back: 'aOK' },
      { model: 'basic', front: 'qBAD', back: 'aBAD' },
    ]);
    const fetchFn = makePermissiveFetch({
      noteIdsToReturn: [200],
      failAddNoteWhere: (note) => note.fields?.Front === 'qBAD',
    });
    const core = createCore(baseConfig({ fetchFn }));
    _setPendingCore(core);

    const result = await dispatchTool(core, 'anki_auto_import_text', {
      deck: 'd',
      sourceText: 'x',
      sourceLabel: 'y',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.imported).toBe(1);
    expect(body.ankiNoteIds).toEqual([200]);
    expect(body.failed).toBe(1);
  });

  it('uses CLAUDECLAW_AGENT_ID env (via core.defaultAgentId) when args.agentId is omitted', async () => {
    _setMockedCards([{ model: 'basic', front: 'q', back: 'a' }]);
    const fetchFn = makePermissiveFetch({ noteIdsToReturn: [42] });
    const core = createCore(baseConfig({ fetchFn, defaultAgentId: 'research' }));
    _setPendingCore(core);

    await dispatchTool(core, 'anki_auto_import_text', {
      deck: 'd',
      sourceText: 'x',
      sourceLabel: 'y',
      // agentId omitted intentionally
    });
    const row = getDb()
      .prepare(`SELECT agent_id FROM anki_pending_cards`)
      .get() as { agent_id: string };
    expect(row.agent_id).toBe('research');
  });
});

describe('anki_propose_cards_from_text — additional coverage', () => {
  it('dedups against not-yet-approved pending cards (Story 9 P2 fix)', async () => {
    _setMockedCards([{ model: 'basic', front: 'q-dup', back: 'a-dup' }]);
    const core = createCore(baseConfig());
    _setPendingCore(core);

    // First propose lands one card in pending
    const first = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd',
      sourceText: 'src',
      sourceLabel: 'lbl',
    });
    expect(JSON.parse(first.content[0].text).proposed).toBe(1);

    // Re-propose the same content BEFORE approval — should be deduped
    const second = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd',
      sourceText: 'src',
      sourceLabel: 'lbl',
    });
    const body = JSON.parse(second.content[0].text);
    expect(body.proposed).toBe(0);
    expect(body.duplicates).toBe(1);
  });

  it('rejects maxCards outside [1, 12]', async () => {
    const core = createCore(baseConfig());
    const tooLow = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd', sourceText: 'x', sourceLabel: 'y', maxCards: 0,
    });
    expect(tooLow.isError).toBe(true);
    expect(tooLow.content[0].text).toMatch(/maxCards must be between/);

    const tooHigh = await dispatchTool(core, 'anki_propose_cards_from_text', {
      deck: 'd', sourceText: 'x', sourceLabel: 'y', maxCards: 99,
    });
    expect(tooHigh.isError).toBe(true);
  });
});
