import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../canvas-render.js', () => ({
  renderHtmlToPng: vi.fn(async () => null),
}));

import { _initTestDatabase } from '../db.js';
import { _setCoreForTests } from '../anki-pending.js';
import {
  _setDocAllowedPrefixesForTests,
  detectDocFormat,
  fileToText,
  generateCardsFromDocument,
  readDocFromPath,
} from './document.js';
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

beforeEach(() => {
  _initTestDatabase();
  _setCoreForTests(makeStubCore());
});

describe('detectDocFormat', () => {
  it('detects html, md, text from extensions', () => {
    expect(detectDocFormat('foo.html')).toBe('html');
    expect(detectDocFormat('foo.htm')).toBe('html');
    expect(detectDocFormat('foo.HTML')).toBe('html');
    expect(detectDocFormat('foo.md')).toBe('md');
    expect(detectDocFormat('foo.markdown')).toBe('md');
    expect(detectDocFormat('foo.txt')).toBe('text');
    expect(detectDocFormat('foo.text')).toBe('text');
    expect(detectDocFormat('foo.unknown')).toBe('text'); // fallback
  });
});

describe('fileToText — HTML stripping', () => {
  it('passes markdown and text through unchanged', () => {
    expect(fileToText('# Heading\n\nbody', 'md')).toBe('# Heading\n\nbody');
    expect(fileToText('plain text body', 'text')).toBe('plain text body');
  });

  it('drops script, style, svg, and comments entirely', () => {
    const html = '<p>visible</p><script>alert(1)</script><style>.x{}</style><svg><circle/></svg><!-- comment --><p>also visible</p>';
    const out = fileToText(html, 'html');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('.x{}');
    expect(out).not.toContain('circle');
    expect(out).not.toContain('comment');
    expect(out).toContain('visible');
    expect(out).toContain('also visible');
  });

  it('converts headings to markdown-style #', () => {
    const html = '<h1>One</h1><h2>Two</h2><h3>Three</h3>';
    const out = fileToText(html, 'html');
    expect(out).toMatch(/^# One/m);
    expect(out).toMatch(/^## Two/m);
    expect(out).toMatch(/^### Three/m);
  });

  it('flattens lists to bullets', () => {
    const html = '<ul><li>first</li><li>second</li></ul>';
    const out = fileToText(html, 'html');
    expect(out).toContain('- first');
    expect(out).toContain('- second');
  });

  it('preserves code blocks fenced', () => {
    const html = '<pre><code>const x = 1;</code></pre>';
    const out = fileToText(html, 'html');
    expect(out).toContain('```');
    expect(out).toContain('const x = 1;');
  });

  it('inlines <code> spans with backticks', () => {
    const html = '<p>Use <code>foo</code> instead.</p>';
    const out = fileToText(html, 'html');
    expect(out).toContain('`foo`');
  });

  it('decodes common HTML entities', () => {
    const html = '<p>&amp; &lt;tag&gt; &quot;quoted&quot; &mdash; end</p>';
    const out = fileToText(html, 'html');
    expect(out).toContain('& <tag> "quoted" — end');
  });

  it('collapses excessive blank lines', () => {
    const html = '<p>one</p>\n\n\n<p>two</p>\n\n\n<p>three</p>';
    const out = fileToText(html, 'html');
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe('readDocFromPath', () => {
  it('reads a file with detected format', () => {
    const tmp = path.join(os.tmpdir(), `doc-${Date.now()}.html`);
    fs.writeFileSync(tmp, '<h1>title</h1><p>body</p>');
    try {
      const doc = readDocFromPath(tmp);
      expect(doc.format).toBe('html');
      expect(doc.title).toBe(path.basename(tmp));
      expect(doc.content).toContain('<h1>title</h1>');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('rejects relative paths', () => {
    expect(() => readDocFromPath('relative/path.html')).toThrow(/must be absolute/);
  });

  it('rejects paths outside allowed prefixes (no /etc/passwd reads)', () => {
    _setDocAllowedPrefixesForTests(['/some/known/prefix']);
    try {
      expect(() => readDocFromPath('/etc/passwd')).toThrow(/outside allowed prefixes/);
    } finally {
      _setDocAllowedPrefixesForTests(null);
    }
  });

  it('rejects paths with null bytes', () => {
    _setDocAllowedPrefixesForTests([os.tmpdir()]);
    try {
      expect(() => readDocFromPath(`${os.tmpdir()}/foo\0.html`)).toThrow(/null byte/);
    } finally {
      _setDocAllowedPrefixesForTests(null);
    }
  });

  it('rejects oversize docs (>5MB)', () => {
    const tmp = path.join(os.tmpdir(), `oversized-${Date.now()}.html`);
    // Write a 6MB file
    fs.writeFileSync(tmp, '<p>x</p>'.repeat(800_000));
    try {
      expect(() => readDocFromPath(tmp)).toThrow(/too large/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('rejects directories', () => {
    expect(() => readDocFromPath(os.tmpdir())).toThrow(/not a regular file/);
  });
});

describe('generateCardsFromDocument', () => {
  it('runs HTML doc → strip → LLM → batch', async () => {
    const llm = mockLlm({
      cards: [
        { model: 'basic', front: 'What is the topic?', back: 'Stayman convention details.' },
      ],
    });
    const html = '<h1>Stayman</h1><p>2♣ over 1NT asks opener for a 4-card major. Responder needs 8+ HCP.</p>';
    const result = await generateCardsFromDocument(
      { content: html, format: 'html', title: 'stayman-notes.html' },
      {
        deck: 'Bridge::Test',
        agentId: 'main',
        llm,
      },
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.pendingIds).toHaveLength(1);
  });

  it('throws when the document has no extractable text', async () => {
    const llm = mockLlm({ cards: [{ model: 'basic', front: 'x', back: 'y' }] });
    await expect(
      generateCardsFromDocument(
        { content: '<style>.x{}</style><script>foo</script>', format: 'html', title: 'empty.html' },
        { deck: 'd', agentId: 'main', llm },
      ),
    ).rejects.toThrow(/no extractable text/);
  });
});
