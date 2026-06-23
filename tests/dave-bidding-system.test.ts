import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

import { _initTestDatabase, getDb } from '../db.js';
import { _setCoreForTests } from '../anki-pending.js';
import { importDaveBlocks, parseDaveKbBlocks } from './dave-bidding-system.js';
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

function mockLlm(payload: unknown): typeof import('../gemini.js').generateContent {
  return (async () => JSON.stringify(payload)) as typeof import('../gemini.js').generateContent;
}

// A minimal Dave-style HTML fixture covering three blocks across two sections.
const DAVE_HTML_FIXTURE = `<!DOCTYPE html>
<html><body>
<h2 class="section-heading" id="s0">0. Foundations</h2>
<h3 class="sub-heading" id="s0-1">0.1 About this system</h3>

<div class="principle">
  <h4 class="principle-heading">Document purpose &amp; audience <span class="badge conf">confirmed</span></h4>
  <p class="block-ref">block-ref: <code>KB-BP-021</code></p>
  <span class="field-label">Statement</span>
  <p>This document makes the principles underlying bridge bidding explicit and teachable.</p>
  <span class="field-label">Rationale</span>
  <p>Distinguishes from rules-of-bridge texts that lack principles.</p>
</div>

<div class="principle">
  <h4 class="principle-heading">Scope <span class="badge draft">drafted</span></h4>
  <p class="block-ref">block-ref: <code>KB-BP-022</code></p>
  <span class="field-label">Statement</span>
  <p>Standard American with 5-card majors.</p>
</div>

<h2 class="section-heading" id="s1">1. Principles</h2>
<h3 class="sub-heading" id="s1-1">1.1 Forcing Framework</h3>

<div class="principle">
  <h4 class="principle-heading">New suits are forcing <span class="badge conf">confirmed</span></h4>
  <p class="block-ref">block-ref: <code>KB-BP-100</code></p>
  <span class="field-label">Statement</span>
  <p>New suits bid by responder are forcing unless responder is a passed hand.</p>
  <span class="field-label">Corollary</span>
  <p>Raises, rebids, and notrump bids by responder are not forcing.</p>
</div>

<div class="principle">
  <h4 class="principle-heading">Old block <span class="badge superseded">superseded</span></h4>
  <p class="block-ref">block-ref: <code>KB-BP-001</code></p>
  <span class="field-label">Statement</span>
  <p>Absorbed into KB-BP-254.</p>
</div>
</body></html>`;

beforeEach(() => {
  _initTestDatabase();
  _setCoreForTests(makeStubCore());
});

describe('parseDaveKbBlocks', () => {
  it('extracts every principle block with ref, title, status, fields, and section', () => {
    const blocks = parseDaveKbBlocks(DAVE_HTML_FIXTURE);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({
      ref: 'KB-BP-021',
      status: 'confirmed',
      section: '0.1 About this system',
    });
    expect(blocks[0].title).toBe('Document purpose & audience');
    expect(blocks[0].fields.Statement).toContain('teachable');
    expect(blocks[0].fields.Rationale).toContain('Distinguishes');

    expect(blocks[1].status).toBe('drafted');
    expect(blocks[1].section).toBe('0.1 About this system');

    expect(blocks[2]).toMatchObject({
      ref: 'KB-BP-100',
      status: 'confirmed',
      section: '1.1 Forcing Framework',
    });
    expect(blocks[2].fields.Corollary).toContain('not forcing');

    expect(blocks[3].status).toBe('superseded');
  });

  it('skips principle blocks lacking a block-ref', () => {
    const broken = `<div class="principle">
      <h4 class="principle-heading">No ref <span class="badge conf">confirmed</span></h4>
      <span class="field-label">Statement</span>
      <p>orphan</p>
    </div>`;
    expect(parseDaveKbBlocks(broken)).toEqual([]);
  });

  // Real Dave HTML has 57% of principles wrapping inner <div> children
  // (e.g. <div class="dave-says">). A non-greedy regex would terminate at
  // the inner </div> and drop every field declared after it. This test
  // pins the depth-tracking walker against regression.
  it('survives nested <div> children inside principle bodies (depth-tracking)', () => {
    const html = `<h3 class="sub-heading">1.1 X</h3>
    <div class="principle">
      <h4 class="principle-heading">Title <span class="badge conf">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-300</code></p>
      <span class="field-label">Statement</span>
      <p>First field content.</p>
      <div class="dave-says">This is Dave's distinctive position note.</div>
      <span class="field-label">Rationale</span>
      <p>This field comes AFTER the nested div — would be lost with non-greedy regex.</p>
      <span class="field-label">Worked example</span>
      <p>Also after the nested div.</p>
    </div>`;
    const blocks = parseDaveKbBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fields.Statement).toContain('First field content.');
    expect(blocks[0].fields.Rationale).toContain('would be lost with non-greedy regex');
    expect(blocks[0].fields['Worked example']).toContain('Also after the nested div.');
  });

  it('survives DEEPLY nested div trees inside principle bodies', () => {
    const html = `<div class="principle">
      <h4 class="principle-heading">Title <span class="badge conf">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-301</code></p>
      <span class="field-label">Statement</span>
      <p>Has <div class="inner"><div class="deeper">nested deeply</div></div> children.</p>
      <span class="field-label">Final</span>
      <p>Last field — must survive depth tracking.</p>
    </div>`;
    const blocks = parseDaveKbBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fields.Final).toContain('Last field');
  });

  // Edge #3 from code review — badge with multiple class tokens
  it('recognizes status even when badge has additional class tokens', () => {
    const html = `<div class="principle">
      <h4 class="principle-heading">Title <span class="badge conf featured highlighted">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-302</code></p>
      <span class="field-label">Statement</span>
      <p>x</p>
    </div>`;
    const blocks = parseDaveKbBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe('confirmed');
  });

  // Edge #2 — h2 with nested badge/provenance spans shouldn't pollute section name
  it('strips badge/provenance markers from section headings', () => {
    const html = `<h2 class="section-heading">0. Foundations <span class="badge draft">drafted</span> <span class="provenance from-dave">from Dave</span></h2>
    <div class="principle">
      <h4 class="principle-heading">x <span class="badge conf">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-303</code></p>
      <span class="field-label">Statement</span>
      <p>x</p>
    </div>`;
    const blocks = parseDaveKbBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].section).toBe('0. Foundations');
    expect(blocks[0].section).not.toContain('drafted');
    expect(blocks[0].section).not.toContain('from Dave');
  });

  // Numeric and named entity decoding (Blind #4 fix)
  it('decodes numeric and HTML entity references in field content', () => {
    const html = `<div class="principle">
      <h4 class="principle-heading">x <span class="badge conf">confirmed</span></h4>
      <p class="block-ref">block-ref: <code>KB-BP-304</code></p>
      <span class="field-label">Statement</span>
      <p>If a &lt; b and c &#34;quoted&#34; and d &#x27;apos&#x27; and e &apos;another&apos;.</p>
    </div>`;
    const blocks = parseDaveKbBlocks(html);
    expect(blocks).toHaveLength(1);
    const stmt = blocks[0].fields.Statement;
    expect(stmt).toContain('a < b');
    expect(stmt).toContain('"quoted"');
    expect(stmt).toContain("'apos'");
    expect(stmt).toContain("'another'");
  });
});

describe('importDaveBlocks', () => {
  function writeFixture(): string {
    const tmp = path.join(os.tmpdir(), `dave-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`);
    fs.writeFileSync(tmp, DAVE_HTML_FIXTURE);
    return tmp;
  }

  it('filters to confirmed status by default + processes within max', async () => {
    const tmp = writeFixture();
    try {
      // Each block call gets a DISTINCT card; otherwise the Story 9 pending-
      // dedup catches the second one as a duplicate of the first.
      let callCount = 0;
      const llm: typeof import('../gemini.js').generateContent = (async () => {
        callCount++;
        return JSON.stringify({
          cards: [{ model: 'basic', front: `q${callCount}`, back: `a${callCount}` }],
        });
      }) as typeof import('../gemini.js').generateContent;
      const r = await importDaveBlocks(tmp, { llm, maxBlocks: 5 });
      // Confirmed only: KB-BP-021 + KB-BP-100 (drafted + superseded excluded)
      expect(r.matchingBlocks).toBe(2);
      expect(r.processedBlocks).toHaveLength(2);
      expect(r.processedBlocks.map((b) => b.ref)).toEqual(['KB-BP-021', 'KB-BP-100']);
      expect(r.totalBlocks).toBe(4);
      expect(r.pendingIds).toHaveLength(2); // one card per block, batched together
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('respects pagination via skip + maxBlocks', async () => {
    const tmp = writeFixture();
    try {
      const llm = mockLlm({ cards: [{ model: 'basic', front: 'q', back: 'a' }] });
      const first = await importDaveBlocks(tmp, { llm, maxBlocks: 1, skip: 0 });
      expect(first.processedBlocks.map((b) => b.ref)).toEqual(['KB-BP-021']);
      const second = await importDaveBlocks(tmp, { llm, maxBlocks: 1, skip: 1 });
      expect(second.processedBlocks.map((b) => b.ref)).toEqual(['KB-BP-100']);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('respects section keyword filter (case-insensitive substring)', async () => {
    const tmp = writeFixture();
    try {
      const llm = mockLlm({ cards: [{ model: 'basic', front: 'q', back: 'a' }] });
      const r = await importDaveBlocks(tmp, { llm, section: 'forcing' });
      expect(r.processedBlocks.map((b) => b.ref)).toEqual(['KB-BP-100']);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('honors a statuses override (e.g. include drafted)', async () => {
    const tmp = writeFixture();
    try {
      const llm = mockLlm({ cards: [{ model: 'basic', front: 'q', back: 'a' }] });
      const r = await importDaveBlocks(tmp, { llm, statuses: ['confirmed', 'drafted'] });
      expect(r.matchingBlocks).toBe(3); // 021, 022, 100
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('all blocks share one batch_id so user can bulk-approve', async () => {
    const tmp = writeFixture();
    try {
      const llm = mockLlm({ cards: [{ model: 'basic', front: 'q', back: 'a' }] });
      const r = await importDaveBlocks(tmp, { llm });
      expect(r.batchId).toBeDefined();
      // Read back the rows to confirm all share the same batch
      const rows = getDb()
        .prepare(`SELECT DISTINCT batch_id FROM anki_pending_cards`)
        .all() as Array<{ batch_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].batch_id).toBe(r.batchId);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('rejects non-HTML files clearly', async () => {
    const tmp = path.join(os.tmpdir(), `notes-${Date.now()}.md`);
    fs.writeFileSync(tmp, '# notes');
    try {
      await expect(importDaveBlocks(tmp)).rejects.toThrow(/expected an HTML file/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('survives one block failing the LLM round-trip and continues with the rest', async () => {
    const tmp = writeFixture();
    try {
      let call = 0;
      // First block fails; second succeeds.
      const llm: typeof import('../gemini.js').generateContent = (async () => {
        call++;
        if (call === 1) throw new Error('LLM blew up');
        return JSON.stringify({ cards: [{ model: 'basic', front: 'q2', back: 'a2' }] });
      }) as typeof import('../gemini.js').generateContent;
      const r = await importDaveBlocks(tmp, { llm, maxBlocks: 5 });
      expect(r.processedBlocks).toHaveLength(2);
      expect(r.perBlock.map((p) => p.accepted.length)).toEqual([0, 1]);
      expect(r.pendingIds).toHaveLength(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
