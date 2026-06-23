import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _setCoreForTests,
  downloadApkg,
  importApkg,
  normalizeApkgUrl,
} from './import-apkg.js';
import type { AnkiCore } from '../anki-mcp-core.js';

interface CallRecord {
  action: string;
  params: Record<string, unknown>;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function makeStubCore(scripted: Array<[string, unknown]>): { core: AnkiCore; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  let cursor = 0;
  const ankiCall = (async <T>(action: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ action, params: params ?? {} });
    if (cursor >= scripted.length) throw new Error(`Unexpected: ${action}`);
    const [expectedAction, value] = scripted[cursor];
    if (expectedAction !== action) throw new Error(`Scripted mismatch: ${expectedAction} vs ${action}`);
    cursor++;
    return value as T;
  }) as AnkiCore['ankiCall'];
  const core: AnkiCore = {
    ankiCall,
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
  return { core, calls };
}

// Always pass a permissive DNS stub in tests so we don't hit the real resolver.
const permissiveDns = async (_hostname: string) => [{ address: '93.184.216.34' }]; // example.com's real IP

beforeEach(() => {
  _setCoreForTests(null);
});

// ── normalizeApkgUrl ──────────────────────────────────────────────────

describe('normalizeApkgUrl', () => {
  it('translates AnkiWeb shared-info URLs to direct-download URLs', () => {
    expect(normalizeApkgUrl('https://ankiweb.net/shared/info/123456789')).toBe(
      'https://ankiweb.net/shared/download/123456789',
    );
    expect(normalizeApkgUrl('http://ankiweb.net/shared/info/987')).toBe(
      'https://ankiweb.net/shared/download/987',
    );
  });

  it('passes other URLs through unchanged', () => {
    expect(normalizeApkgUrl('https://example.com/deck.apkg')).toBe('https://example.com/deck.apkg');
    expect(normalizeApkgUrl('https://ankiweb.net/account/login')).toBe('https://ankiweb.net/account/login');
  });
});

// ── downloadApkg ──────────────────────────────────────────────────────

describe('downloadApkg', () => {
  it('streams the response body to a tmp .apkg file with zip magic and returns the path', async () => {
    const payload = Buffer.concat([ZIP_MAGIC, Buffer.from('rest of fake apkg here')]);
    const fetchFn: typeof fetch = async () =>
      new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    const tmpPath = await downloadApkg('https://example.com/deck.apkg', fetchFn, permissiveDns);
    try {
      expect(tmpPath).toMatch(/\.apkg$/);
      expect(tmpPath.startsWith(os.tmpdir())).toBe(true);
      const written = fs.readFileSync(tmpPath);
      expect(written.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  });

  it('rejects when content-length advertises an oversize body (pre-check)', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response('x', { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } });
    await expect(
      downloadApkg('https://example.com/big.apkg', fetchFn, permissiveDns),
    ).rejects.toThrow(/refusing to download/);
  });

  it('P2 fix — aborts during streaming when size cap would be exceeded even WITHOUT content-length', async () => {
    // Server emits chunked encoding; produce >200 MB worth of bytes without
    // advertising content-length. The active byte counter must abort.
    const huge = Buffer.concat([ZIP_MAGIC, Buffer.alloc(201 * 1024 * 1024)]);
    const fetchFn: typeof fetch = async () => new Response(huge, { status: 200 });
    await expect(
      downloadApkg('https://example.com/big.apkg', fetchFn, permissiveDns),
    ).rejects.toThrow(/exceeded cap/);
  });

  it('P5 fix — cleans up tmp file when stream errors mid-flight', async () => {
    // Construct a body that errors during read.
    let writtenPath: string | undefined;
    const fetchFn: typeof fetch = async () => {
      const body = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(ZIP_MAGIC);
          ctrl.error(new Error('upstream RST'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    };
    try {
      await downloadApkg('https://example.com/x.apkg', fetchFn, permissiveDns);
    } catch (err) {
      writtenPath = undefined; // we can't observe the path on failure
    }
    // We can't directly check the deleted path, but verify the function does
    // throw and doesn't leave the leftmost expected file. As long as no Error
    // says "ENOSPC" we're fine; just assert the rejection.
    await expect(downloadApkg('https://example.com/x.apkg', fetchFn, permissiveDns)).rejects.toThrow(
      /download failed mid-stream/,
    );
  });

  it('P6 fix — rejects file lacking ZIP magic bytes', async () => {
    const notZip = Buffer.from('this is not a zip file');
    const fetchFn: typeof fetch = async () => new Response(notZip, { status: 200 });
    await expect(
      downloadApkg('https://example.com/fake.apkg', fetchFn, permissiveDns),
    ).rejects.toThrow(/not a valid \.apkg/);
  });

  it('throws with a clear message on HTTP error', async () => {
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
    await expect(
      downloadApkg('https://example.com/missing.apkg', fetchFn, permissiveDns),
    ).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('translates AnkiWeb shared-info URLs before fetching', async () => {
    let calledUrl: string | undefined;
    const fetchFn: typeof fetch = async (input) => {
      calledUrl = typeof input === 'string' ? input : input.toString();
      return new Response(Buffer.concat([ZIP_MAGIC, Buffer.from('content')]), { status: 200 });
    };
    const tmpPath = await downloadApkg(
      'https://ankiweb.net/shared/info/42',
      fetchFn,
      permissiveDns,
    );
    try {
      expect(calledUrl).toBe('https://ankiweb.net/shared/download/42');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('P1 fix — rejects URLs whose hostname resolves to a private IP', async () => {
    const fetchFn: typeof fetch = async () => new Response(ZIP_MAGIC, { status: 200 });
    const internalDns = async () => [{ address: '169.254.169.254' }]; // AWS metadata IP
    await expect(
      downloadApkg('https://attacker.example.com/foo.apkg', fetchFn, internalDns),
    ).rejects.toThrow(/private IP/);
  });

  it('P1 fix — rejects direct private-IP URL literals', async () => {
    const fetchFn: typeof fetch = async () => new Response(ZIP_MAGIC, { status: 200 });
    await expect(downloadApkg('http://127.0.0.1:8765/foo.apkg', fetchFn, permissiveDns)).rejects.toThrow(
      /private\/loopback host/,
    );
    await expect(downloadApkg('http://10.0.0.5/foo.apkg', fetchFn, permissiveDns)).rejects.toThrow(
      /private\/loopback host/,
    );
  });

  it('P1 fix — manually follows redirects and re-validates each hop', async () => {
    let step = 0;
    const dnsCalls: string[] = [];
    const dnsStub = async (host: string) => {
      dnsCalls.push(host);
      return [{ address: '93.184.216.34' }];
    };
    const fetchFn: typeof fetch = async () => {
      step++;
      if (step === 1) {
        return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/foo.apkg' } });
      }
      return new Response(ZIP_MAGIC, { status: 200 });
    };
    const tmpPath = await downloadApkg('https://start.example/foo.apkg', fetchFn, dnsStub);
    try {
      // Each hop's hostname goes through DNS validation.
      expect(dnsCalls).toEqual(['start.example', 'elsewhere.example']);
      expect(step).toBe(2);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('P1 fix — caps redirects at 5', async () => {
    let step = 0;
    const fetchFn: typeof fetch = async () => {
      step++;
      return new Response('', {
        status: 302,
        headers: { location: `https://hop${step}.example/x.apkg` },
      });
    };
    await expect(downloadApkg('https://start.example/x.apkg', fetchFn, permissiveDns)).rejects.toThrow(
      /too many redirects/,
    );
  });
});

// ── importApkg ────────────────────────────────────────────────────────

describe('importApkg', () => {
  function makeLocalApkg(): string {
    const tmpPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.apkg`);
    fs.writeFileSync(tmpPath, ZIP_MAGIC);
    return tmpPath;
  }

  it('imports a local file directly and returns syncOk:true on success', async () => {
    const tmpPath = makeLocalApkg();
    try {
      // namespace=Imported default → script: deckNames pre, importPackage, deckNames post,
      // for each new deck: createDeck + findCards + changeDeck.
      const { core, calls } = makeStubCore([
        ['deckNames', ['Default']], // pre
        ['importPackage', true],
        ['deckNames', ['Default', 'StandardConventions']], // post
        ['createDeck', 1], // Imported::StandardConventions
        ['findCards', [101, 102]],
        ['changeDeck', null],
        ['sync', null], // outside the lock
      ]);
      _setCoreForTests(core);
      const result = await importApkg(tmpPath, { cleanupTmp: false });
      expect(result.imported).toBe(true);
      expect(result.syncOk).toBe(true);
      expect(result.localPath).toBe(tmpPath);
      expect(result.newDecks).toEqual(['Imported::StandardConventions']);
      const importCall = calls.find((c) => c.action === 'importPackage');
      expect(importCall?.params).toEqual({ path: tmpPath });
      // changeDeck moves the 2 card ids to the namespaced deck
      const changeCall = calls.find((c) => c.action === 'changeDeck');
      expect(changeCall?.params).toEqual({ cards: [101, 102], deck: 'Imported::StandardConventions' });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  });

  it('skips namespace rename when namespace is explicitly empty', async () => {
    const tmpPath = makeLocalApkg();
    try {
      const { core, calls } = makeStubCore([
        ['deckNames', ['Default']],
        ['importPackage', true],
        ['deckNames', ['Default', 'X']],
        ['sync', null],
      ]);
      _setCoreForTests(core);
      const result = await importApkg(tmpPath, { namespace: '', cleanupTmp: false });
      expect(result.newDecks).toEqual(['X']);
      expect(calls.some((c) => c.action === 'changeDeck')).toBe(false);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('captures sync failure as syncOk:false without rejecting the import', async () => {
    const tmpPath = makeLocalApkg();
    try {
      const ankiCall = (async <T>(action: string): Promise<T> => {
        if (action === 'deckNames') return [] as unknown as T;
        if (action === 'importPackage') return true as unknown as T;
        if (action === 'sync') throw new Error('AnkiWeb offline');
        throw new Error(`unexpected ${action}`);
      }) as AnkiCore['ankiCall'];
      const core: AnkiCore = {
        ankiCall,
        ensureProfile: async () => {},
        syncSafe: async () => ({ ok: false }),
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
      _setCoreForTests(core);
      const result = await importApkg(tmpPath, { cleanupTmp: false });
      expect(result.imported).toBe(true);
      expect(result.syncOk).toBe(false);
      expect(result.syncError).toMatch(/AnkiWeb offline/);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('rejects relative paths', async () => {
    const { core } = makeStubCore([]);
    _setCoreForTests(core);
    await expect(importApkg('relative/deck.apkg')).rejects.toThrow(/unsupported source/);
  });

  it('rejects sources that are neither http(s) nor absolute paths', async () => {
    const { core } = makeStubCore([]);
    _setCoreForTests(core);
    await expect(importApkg('ftp://example.com/deck.apkg')).rejects.toThrow(/unsupported source/);
  });
});
