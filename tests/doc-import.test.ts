import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

import { _initTestDatabase, getDb, createDocImport, getActiveDocImport, getDocImport, updateDocImport } from '../db.js';
import { _setCoreForTests as _setPendingCore } from '../anki-pending.js';
import { _setDocAllowedPrefixesForTests } from './document.js';
import { _setCoreForTests, detectDocKind, beginDocImport, countDaveBlocks } from './doc-import.js';
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

beforeEach(() => {
  _initTestDatabase();
  _setCoreForTests(makeStubCore());
  _setPendingCore(makeStubCore());
  _setDocAllowedPrefixesForTests([os.tmpdir()]);
});

// ── detectDocKind ────────────────────────────────────────────────────

describe('detectDocKind', () => {
  it('classifies Dave-shape HTML as dave-kb when the KB-BP marker is present', () => {
    const tmp = path.join(os.tmpdir(), `dave-${Date.now()}.html`);
    fs.writeFileSync(
      tmp,
      `<html><body><div class="principle"><p class="block-ref">block-ref: <code>KB-BP-021</code></p></div></body></html>`,
    );
    try {
      expect(detectDocKind(tmp)).toBe('dave-kb');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('classifies generic HTML without the KB marker as generic-html', () => {
    const tmp = path.join(os.tmpdir(), `notes-${Date.now()}.html`);
    fs.writeFileSync(tmp, `<html><body><h1>Bridge notes</h1><p>Stayman is 2C over 1NT.</p></body></html>`);
    try {
      expect(detectDocKind(tmp)).toBe('generic-html');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('classifies .md as md and .txt as text without sniffing content', () => {
    const md = path.join(os.tmpdir(), `notes-${Date.now()}.md`);
    fs.writeFileSync(md, '# heading');
    try {
      expect(detectDocKind(md)).toBe('md');
    } finally {
      fs.unlinkSync(md);
    }
    const txt = path.join(os.tmpdir(), `notes-${Date.now()}.txt`);
    fs.writeFileSync(txt, 'plain text');
    try {
      expect(detectDocKind(txt)).toBe('text');
    } finally {
      fs.unlinkSync(txt);
    }
  });
});

// ── countDaveBlocks ──────────────────────────────────────────────────

describe('countDaveBlocks', () => {
  it('returns total + confirmed counts on Dave-shaped HTML', () => {
    const html = `<html><body>
      <h3 class="sub-heading">0.1</h3>
      <div class="principle">
        <h4 class="principle-heading">A <span class="badge conf">confirmed</span></h4>
        <p class="block-ref">block-ref: <code>KB-BP-1</code></p>
        <span class="field-label">Statement</span><p>x</p>
      </div>
      <div class="principle">
        <h4 class="principle-heading">B <span class="badge draft">drafted</span></h4>
        <p class="block-ref">block-ref: <code>KB-BP-2</code></p>
        <span class="field-label">Statement</span><p>x</p>
      </div>
    </body></html>`;
    const tmp = path.join(os.tmpdir(), `dave-${Date.now()}.html`);
    fs.writeFileSync(tmp, html);
    try {
      const counts = countDaveBlocks(tmp);
      expect(counts).toEqual({ total: 2, confirmed: 1 });
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ── beginDocImport ───────────────────────────────────────────────────

describe('beginDocImport', () => {
  it('stages a row with the detected kind and returns staging_id + block_count for Dave docs', () => {
    const html = `<div class="principle">
      <h4 class="principle-heading">A <span class="badge conf">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-1</code></p>
      <span class="field-label">Statement</span><p>x</p>
    </div>`;
    const tmp = path.join(os.tmpdir(), `dave-${Date.now()}.html`);
    fs.writeFileSync(tmp, html);
    try {
      const result = beginDocImport({ chatId: '42', agentId: 'main', docPath: tmp });
      expect(result.detected_kind).toBe('dave-kb');
      expect(result.block_count).toEqual({ total: 1, confirmed: 1 });
      expect(result.staging_id).toBeGreaterThan(0);
      const row = getDocImport(result.staging_id);
      expect(row?.state).toBe('awaiting-action');
      expect(row?.chat_id).toBe('42');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('stages generic-html for non-Dave HTML and omits block_count', () => {
    const tmp = path.join(os.tmpdir(), `gen-${Date.now()}.html`);
    fs.writeFileSync(tmp, '<h1>foo</h1><p>bar</p>');
    try {
      const result = beginDocImport({ chatId: '42', agentId: 'main', docPath: tmp });
      expect(result.detected_kind).toBe('generic-html');
      expect(result.block_count).toBeUndefined();
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('cancels any prior active row for the same chat (only one in-flight)', () => {
    const tmp1 = path.join(os.tmpdir(), `a-${Date.now()}.html`);
    fs.writeFileSync(tmp1, '<h1>a</h1>');
    const tmp2 = path.join(os.tmpdir(), `b-${Date.now()}.html`);
    fs.writeFileSync(tmp2, '<h1>b</h1>');
    try {
      const a = beginDocImport({ chatId: '42', agentId: 'main', docPath: tmp1 });
      const b = beginDocImport({ chatId: '42', agentId: 'main', docPath: tmp2 });
      // The earlier row should now be cancelled
      expect(getDocImport(a.staging_id)?.state).toBe('cancelled');
      expect(getDocImport(b.staging_id)?.state).toBe('awaiting-action');
      // getActiveDocImport returns the latest
      expect(getActiveDocImport('42')?.id).toBe(b.staging_id);
    } finally {
      fs.unlinkSync(tmp1);
      fs.unlinkSync(tmp2);
    }
  });

  it('rejects paths outside the document allowlist (defense-in-depth)', () => {
    _setDocAllowedPrefixesForTests(['/some/protected/dir']);
    expect(() => beginDocImport({ chatId: '42', agentId: 'main', docPath: '/etc/passwd' })).toThrow(
      /outside allowed prefixes/,
    );
  });
});

// ── Staging CRUD ─────────────────────────────────────────────────────

describe('pending_doc_imports CRUD', () => {
  it('createDocImport + getActiveDocImport + updateDocImport happy path', () => {
    const id = createDocImport({ chatId: '42', agentId: 'main', docPath: '/tmp/x.html', detectedKind: 'generic-html' });
    expect(id).toBeGreaterThan(0);
    const active = getActiveDocImport('42');
    expect(active?.id).toBe(id);
    updateDocImport(id, { action: 'new', state: 'awaiting-name' });
    expect(getDocImport(id)?.action).toBe('new');
    expect(getDocImport(id)?.state).toBe('awaiting-name');
    updateDocImport(id, { targetDeck: 'Bridge::Foo', state: 'executing' });
    const updated = getDocImport(id);
    expect(updated?.target_deck).toBe('Bridge::Foo');
    expect(updated?.state).toBe('executing');
    updateDocImport(id, { state: 'completed' });
    expect(getActiveDocImport('42')).toBeNull(); // completed → not "active"
  });
});
