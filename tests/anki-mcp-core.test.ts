import { describe, it, expect } from 'vitest';

import { createCore, dispatchTool, type AnkiCoreConfig } from './anki-mcp-core.js';

interface FetchCall {
  url: string;
  action: string;
  params: Record<string, unknown>;
  version: number;
  bodyRaw: string;
}

type CannedResponse = [string, unknown] | [string, unknown, string | null];

/**
 * Builds a fetch stub that pulls canned responses off a queue keyed by AnkiConnect
 * action name, and records every outbound call so tests can assert request shape.
 *
 * `responses` is a list of [action, value] pairs consumed in order. If the action
 * matches the next entry, that entry's value becomes the `result` field of the
 * AnkiConnect response envelope. Unmatched actions throw, which surfaces test bugs
 * (a missing expectation) as a clear failure rather than a hang.
 */
function makeFetchStub(responses: CannedResponse[]) {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyRaw = (init?.body as string) ?? '{}';
    const body = JSON.parse(bodyRaw);
    calls.push({ url, action: body.action, params: body.params ?? {}, version: body.version, bodyRaw });
    if (cursor >= responses.length) {
      throw new Error(`Unexpected AnkiConnect call: ${body.action} (no canned response left)`);
    }
    const [expectedAction, result, error = null] = responses[cursor];
    if (expectedAction !== body.action) {
      throw new Error(`Test expectation mismatch: queue had ${expectedAction}, MCP called ${body.action}`);
    }
    cursor++;
    return new Response(JSON.stringify({ result, error }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

const baseConfig = (overrides?: Partial<AnkiCoreConfig>): AnkiCoreConfig => ({
  ankiConnectUrl: 'http://127.0.0.1:8765',
  defaultProfile: 'Brian',
  ...overrides,
});

// ───────────────────────────────────────────────────────────────────────────
// ankiCall envelope
// ───────────────────────────────────────────────────────────────────────────

describe('anki-mcp-core: ankiCall envelope', () => {
  it('wraps action+params in the AnkiConnect JSON-RPC envelope with version 6', async () => {
    const { fetchFn, calls } = makeFetchStub([['version', 6]]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await core.ankiCall<number>('version');
    expect(result).toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('version');
    expect(calls[0].version).toBe(6);
    expect(calls[0].url).toBe('http://127.0.0.1:8765');
  });

  it('throws with a clear message when AnkiConnect returns an error', async () => {
    const { fetchFn } = makeFetchStub([['addNote', null, 'deck was not found: Bridge::DoesNotExist']]);
    const core = createCore(baseConfig({ fetchFn }));
    await expect(core.ankiCall('addNote')).rejects.toThrow(/AnkiConnect addNote:.*deck was not found/);
  });

  it('throws a "transport error" message when fetch itself fails', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const core = createCore(baseConfig({ fetchFn }));
    await expect(core.ankiCall('version')).rejects.toThrow(/transport error.*ECONNREFUSED/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ensureProfile (P1/M6)
// ───────────────────────────────────────────────────────────────────────────

describe('anki-mcp-core: ensureProfile profile-switch logic', () => {
  it('is a no-op when active profile already matches the requested one', async () => {
    const { fetchFn, calls } = makeFetchStub([['getActiveProfile', 'Brian']]);
    const core = createCore(baseConfig({ fetchFn }));
    await core.ensureProfile('Brian');
    expect(calls.map((c) => c.action)).toEqual(['getActiveProfile']);
  });

  it('issues loadProfile and re-verifies when active differs (M6 fix)', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['loadProfile', null],
      ['getActiveProfile', 'Jodie'], // M6: re-check after loadProfile
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    await core.ensureProfile('Jodie');
    expect(calls.map((c) => c.action)).toEqual(['getActiveProfile', 'loadProfile', 'getActiveProfile']);
    expect(calls[1].params).toEqual({ name: 'Jodie' });
  });

  it('M6 — throws when loadProfile silently fails to switch (active stays wrong)', async () => {
    const { fetchFn } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['loadProfile', null], // returns success but didn't actually switch
      ['getActiveProfile', 'Brian'], // still Brian after loadProfile
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    await expect(core.ensureProfile('Jodie')).rejects.toThrow(/did not switch.*active is still 'Brian'/);
  });

  it('falls back to defaultProfile when caller passes empty string', async () => {
    const { fetchFn, calls } = makeFetchStub([['getActiveProfile', 'Brian']]);
    const core = createCore(baseConfig({ fetchFn, defaultProfile: 'Brian' }));
    await core.ensureProfile('');
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('getActiveProfile');
  });

  it('throws when neither caller-profile nor defaultProfile is set', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn, defaultProfile: '' }));
    await expect(core.ensureProfile('')).rejects.toThrow(/No Anki profile specified.*ANKI_PROFILE/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Profile mutex (P1)
// ───────────────────────────────────────────────────────────────────────────

describe('anki-mcp-core: withProfileLock serializes profile-dependent work (P1)', () => {
  it('two concurrent dispatchTool calls do not interleave their profile-dependent ankiCalls', async () => {
    // Each call: getActiveProfile + loadProfile + getActiveProfile (M6 re-check) + addNote + getActiveProfile (syncSafe) + sync
    // = 6 fetches per call, 12 total. If interleaved, action sequence would reorder.
    // Design the canned queue so test A runs to completion BEFORE test B starts.
    const responses: CannedResponse[] = [
      // Call A (profile Brian, active starts as 'Christine')
      ['getActiveProfile', 'Christine'],
      ['loadProfile', null],
      ['getActiveProfile', 'Brian'],
      ['addNote', 1001],
      ['getActiveProfile', 'Brian'], // syncSafe's ensureProfile
      ['sync', null],
      // Call B (profile Jodie, expects active still 'Brian' from A's leftover)
      ['getActiveProfile', 'Brian'],
      ['loadProfile', null],
      ['getActiveProfile', 'Jodie'],
      ['addNote', 2002],
      ['getActiveProfile', 'Jodie'], // syncSafe's ensureProfile
      ['sync', null],
    ];
    const { fetchFn, calls } = makeFetchStub(responses);
    const core = createCore(baseConfig({ fetchFn, defaultProfile: 'Brian' }));
    const [a, b] = await Promise.all([
      dispatchTool(core, 'anki_add_note', {
        profile: 'Brian',
        deck: 'X',
        model: 'Basic',
        fields: { Front: 'a', Back: 'b' },
      }),
      dispatchTool(core, 'anki_add_note', {
        profile: 'Jodie',
        deck: 'Y',
        model: 'Basic',
        fields: { Front: 'c', Back: 'd' },
      }),
    ]);
    // Both succeed
    expect(JSON.parse(a.content[0].text).noteId).toBe(1001);
    expect(JSON.parse(b.content[0].text).noteId).toBe(2002);
    // Call A's entire sequence appears BEFORE any of call B's. The lock guarantees this.
    const actions = calls.map((c) => c.action);
    const aEnd = actions.lastIndexOf('sync', 5); // sync within the first 6 calls
    expect(aEnd).toBe(5); // call A's 6th action is sync
    // Call B begins at index 6 with its own getActiveProfile
    expect(actions[6]).toBe('getActiveProfile');
  });

  it('anki_health does NOT go through the lock — runs concurrently with locked work', async () => {
    // Simple structural test: health is invoked via dispatchHealth fast-path,
    // never touches ensureProfile. With a fetch stub that ONLY expects version
    // + getActiveProfile (no loadProfile call), the test would fail if the lock
    // path was used (it would try ensureProfile first).
    const { fetchFn, calls } = makeFetchStub([
      ['version', 6],
      ['getActiveProfile', 'Brian'],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_health', {});
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.action)).toEqual(['version', 'getActiveProfile']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// syncSafe (P4)
// ───────────────────────────────────────────────────────────────────────────

describe('anki-mcp-core: syncSafe (P4 — only sync() is soft, not ensureProfile)', () => {
  it('returns { ok: true } on successful sync', async () => {
    const { fetchFn } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['sync', null],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await core.syncSafe('Brian');
    expect(result).toEqual({ ok: true });
  });

  it('captures sync-call failure as { ok: false, error } rather than throwing', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.action === 'getActiveProfile') {
        return new Response(JSON.stringify({ result: 'Brian', error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ result: null, error: 'AnkiWeb timeout' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const core = createCore(baseConfig({ fetchFn }));
    const result = await core.syncSafe('Brian');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/AnkiWeb timeout/);
  });

  it('P4 — ensureProfile errors ESCAPE syncSafe (do not get wrapped as sync failure)', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn, defaultProfile: '' }));
    // No profile configured anywhere → ensureProfile throws → syncSafe should propagate.
    await expect(core.syncSafe('')).rejects.toThrow(/No Anki profile specified/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// importPackage validation (P3)
// ───────────────────────────────────────────────────────────────────────────

describe('anki-mcp-core: validateImportPath (P3)', () => {
  it('rejects relative paths', () => {
    const core = createCore(baseConfig());
    expect(() => core.validateImportPath('relative/path.apkg')).toThrow(/must be absolute/);
  });

  it('rejects non-.apkg extensions', () => {
    const core = createCore(
      baseConfig({ statSync: () => ({ isFile: () => true }) }),
    );
    expect(() => core.validateImportPath('/tmp/foo.zip')).toThrow(/only \.apkg files allowed/);
  });

  it('rejects paths with null bytes', () => {
    const core = createCore(baseConfig());
    expect(() => core.validateImportPath('/tmp/foo\0.apkg')).toThrow(/null byte/);
  });

  it('rejects paths that do not exist', () => {
    const statSync = () => {
      throw new Error('ENOENT: no such file or directory');
    };
    const core = createCore(baseConfig({ statSync: statSync as never }));
    expect(() => core.validateImportPath('/tmp/missing.apkg')).toThrow(/cannot stat path/);
  });

  it('rejects paths that exist but are not regular files', () => {
    const core = createCore(
      baseConfig({ statSync: () => ({ isFile: () => false }) }),
    );
    expect(() => core.validateImportPath('/tmp/somedir.apkg')).toThrow(/not a regular file/);
  });

  it('enforces allowed prefixes when configured', () => {
    const core = createCore(
      baseConfig({
        statSync: () => ({ isFile: () => true }),
        importPathAllowedPrefixes: ['/tmp', '/Users/bostrovsky/.claudeclaw/brian'],
      }),
    );
    expect(() =>
      core.validateImportPath('/Users/bostrovsky/.claudeclaw/jodie/deck.apkg'),
    ).toThrow(/outside the allowed prefixes/);
    // Same prefix, different deeper path → ok
    expect(() =>
      core.validateImportPath('/Users/bostrovsky/.claudeclaw/brian/imports/deck.apkg'),
    ).not.toThrow();
  });

  it('accepts an absolute, existing .apkg file when no prefix restriction', () => {
    const core = createCore(baseConfig({ statSync: () => ({ isFile: () => true }) }));
    expect(() => core.validateImportPath('/tmp/anywhere.apkg')).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dispatchTool: anki_health
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: anki_health', () => {
  it('returns ok + version + active profile on the happy path', async () => {
    const { fetchFn } = makeFetchStub([
      ['version', 6],
      ['getActiveProfile', 'Brian'],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_health', {});
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe(6);
    expect(payload.activeProfile).toBe('Brian');
  });

  it('retries up to 3 times before reporting unhealthy', async () => {
    let attempts = 0;
    const fetchFn: typeof fetch = async () => {
      attempts++;
      throw new Error('ECONNREFUSED');
    };
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_health', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toMatch(/Is Anki Desktop running/);
    expect(attempts).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dispatchTool: anki_add_note
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: anki_add_note', () => {
  it('calls addNote with the right note envelope (omitting options when not provided) and syncs after', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'], // ensureProfile (active matches)
      ['addNote', 1722334455],
      ['getActiveProfile', 'Brian'], // syncSafe → ensureProfile
      ['sync', null],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_add_note', {
      profile: 'Brian',
      deck: 'Smoke::Test',
      model: 'Basic',
      fields: { Front: 'Q?', Back: 'A.' },
      tags: ['smoke'],
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.noteId).toBe(1722334455);
    expect(payload.sync).toEqual({ ok: true });

    // L6 fix: assert via raw body that 'options' key is NOT in the JSON when caller didn't pass it.
    // Vitest's toEqual({a: undefined}) matches {}, which was the original test's gap.
    const addCall = calls.find((c) => c.action === 'addNote')!;
    const note = (addCall.params as { note: Record<string, unknown> }).note;
    expect(Object.keys(note).sort()).toEqual(['deckName', 'fields', 'modelName', 'tags']);
    expect(addCall.bodyRaw).not.toContain('"options"');
  });

  it('includes options when caller provides them', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['addNote', 9],
      ['getActiveProfile', 'Brian'],
      ['sync', null],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    await dispatchTool(core, 'anki_add_note', {
      profile: 'Brian',
      deck: 'X',
      model: 'Basic',
      fields: { Front: 'q', Back: 'a' },
      options: { allowDuplicate: true },
    });
    const addCall = calls.find((c) => c.action === 'addNote')!;
    const note = (addCall.params as { note: Record<string, unknown> }).note;
    expect(note.options).toEqual({ allowDuplicate: true });
  });

  it('does NOT abort the addNote when post-write sync fails — returns { sync: ok: false }', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.action === 'getActiveProfile') {
        return new Response(JSON.stringify({ result: 'Brian', error: null }), { status: 200 });
      }
      if (body.action === 'addNote') {
        return new Response(JSON.stringify({ result: 9999, error: null }), { status: 200 });
      }
      if (body.action === 'sync') {
        return new Response(JSON.stringify({ result: null, error: 'AnkiWeb 503' }), { status: 200 });
      }
      throw new Error(`Unexpected action: ${body.action}`);
    };
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_add_note', {
      profile: 'Brian',
      deck: 'X',
      model: 'Basic',
      fields: { Front: 'q', Back: 'a' },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.noteId).toBe(9999);
    expect(payload.sync).toEqual({ ok: false, error: expect.stringMatching(/AnkiWeb 503/) });
  });

  it('returns a structured error when required args are missing', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_add_note', { profile: 'Brian' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/deck is required/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Read paths sync before reading (P2, M2)
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: read paths sync before reading', () => {
  it('anki_find_cards calls sync before findCards and returns sync result (M2 fix)', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Jodie'],
      ['sync', null],
      ['findCards', [101, 102, 103]],
    ]);
    const core = createCore(baseConfig({ fetchFn, defaultProfile: 'Brian' }));
    const result = await dispatchTool(core, 'anki_find_cards', { profile: 'Jodie', query: 'is:due' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cardIds).toEqual([101, 102, 103]);
    expect(payload.sync).toEqual({ ok: true });
    expect(calls.map((c) => c.action)).toEqual(['getActiveProfile', 'sync', 'findCards']);
  });

  it('P2 — anki_cards_info calls sync before cardsInfo (was missing pre-patch)', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['sync', null],
      ['cardsInfo', [{ cardId: 1, queue: 1, reps: 1 }]],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_cards_info', { cards: [1] });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cards).toEqual([{ cardId: 1, queue: 1, reps: 1 }]);
    expect(payload.sync).toEqual({ ok: true });
    expect(calls.map((c) => c.action)).toEqual(['getActiveProfile', 'sync', 'cardsInfo']);
  });

  it('M2 — anki_find_notes returns sync result alongside noteIds', async () => {
    const { fetchFn } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['sync', null],
      ['findNotes', [42]],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_find_notes', { query: 'tag:foo' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ noteIds: [42], sync: { ok: true } });
  });

  it('M2 — find_notes surfaces sync failure so caller knows reads are stale', async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.action === 'getActiveProfile') {
        return new Response(JSON.stringify({ result: 'Brian', error: null }), { status: 200 });
      }
      if (body.action === 'sync') {
        return new Response(JSON.stringify({ result: null, error: 'AnkiWeb offline' }), { status: 200 });
      }
      if (body.action === 'findNotes') {
        return new Response(JSON.stringify({ result: [1, 2], error: null }), { status: 200 });
      }
      throw new Error(`Unexpected: ${body.action}`);
    };
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_find_notes', { query: 'tag:foo' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.noteIds).toEqual([1, 2]);
    expect(payload.sync.ok).toBe(false);
    expect(payload.sync.error).toMatch(/AnkiWeb offline/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dispatchTool: media + import (M1, P3)
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: anki_store_media_file (M1)', () => {
  it('rejects payloads larger than the configured cap', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn }));
    const huge = 'a'.repeat(10_000_001);
    const result = await dispatchTool(core, 'anki_store_media_file', {
      filename: 'big.png',
      data: huge,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/too large/);
  });

  it('sanitizes filenames to prevent path traversal', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['storeMediaFile', 'foo.png'],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    await dispatchTool(core, 'anki_store_media_file', {
      filename: '../../etc/foo.png',
      data: 'aGVsbG8=',
    });
    const storeCall = calls.find((c) => c.action === 'storeMediaFile')!;
    expect(storeCall.params.filename).toBe('foo.png'); // basename
  });
});

describe('dispatchTool: anki_import_package (P3, M5)', () => {
  it('rejects when path validation fails', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_import_package', { path: 'not-absolute.apkg' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be absolute/);
  });

  it('passes validation and calls importPackage when path is acceptable', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['importPackage', true],
      ['getActiveProfile', 'Brian'], // syncSafe's ensureProfile
      ['sync', null],
    ]);
    const core = createCore(
      baseConfig({
        fetchFn,
        statSync: () => ({ isFile: () => true }),
        importPathAllowedPrefixes: ['/tmp'],
      }),
    );
    const result = await dispatchTool(core, 'anki_import_package', { path: '/tmp/deck.apkg' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.imported).toBe(true);
    const importCall = calls.find((c) => c.action === 'importPackage')!;
    expect(importCall.params.path).toBe('/tmp/deck.apkg');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dispatchTool: anki_create_model idempotency
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: anki_create_model idempotency', () => {
  it('skips createModel when the named model already exists in the profile', async () => {
    const { fetchFn, calls } = makeFetchStub([
      ['getActiveProfile', 'Brian'],
      ['modelNames', ['Basic', 'BasicRich']],
    ]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_create_model', {
      modelName: 'BasicRich',
      inOrderFields: ['Front', 'Back'],
      cardTemplates: [{ Front: '{{Front}}', Back: '{{Back}}' }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.created).toBe(false);
    expect(payload.reason).toBe('model exists');
    expect(calls.map((c) => c.action)).toEqual(['getActiveProfile', 'modelNames']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dispatchTool: unknown tool
// ───────────────────────────────────────────────────────────────────────────

describe('dispatchTool: unknown tool', () => {
  it('returns a structured error rather than throwing', async () => {
    const { fetchFn } = makeFetchStub([]);
    const core = createCore(baseConfig({ fetchFn }));
    const result = await dispatchTool(core, 'anki_does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool: anki_does_not_exist/);
  });
});
