/**
 * Generic document → cards adapter.
 *
 * Handles HTML / Markdown / plain text. Strips to readable text preserving
 * block structure (headings → headers, lists → bullets, code blocks → fenced),
 * then routes the result through the cards-from-text pipeline.
 *
 * Inputs:
 *   - text content directly (caller already read the file)
 *   - file path on disk (we read it)
 *
 * Story 3b's HTML stripper is regex-based. Trade-off: no new dep, good
 * enough for Dave's HTML and 90% of well-formed docs. If we hit messy
 * real-world HTML often enough, swap to cheerio later.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Context } from 'grammy';

import { generateCardsFromText, sendCardsFromText, type CardsFromTextOpts, type CardsFromTextResult } from './text.js';

export type DocFormat = 'html' | 'md' | 'text';

export interface FromDocOpts extends Omit<CardsFromTextOpts, 'sourceType' | 'sourceLabel'> {
  /** Override the auto-detected sourceType (default: "doc-<format>"). */
  sourceType?: string;
  /** Override the default source label (default: the document title/filename). */
  sourceLabel?: string;
}

const HTML_EXT_RE = /\.html?$/i;
const MD_EXT_RE = /\.(md|markdown)$/i;
const TXT_EXT_RE = /\.(txt|text)$/i;

/** Detect format from a filename. Defaults to text. */
export function detectDocFormat(filename: string): DocFormat {
  if (HTML_EXT_RE.test(filename)) return 'html';
  if (MD_EXT_RE.test(filename)) return 'md';
  if (TXT_EXT_RE.test(filename)) return 'text';
  return 'text';
}

/**
 * Convert source content to plain readable text. Markdown and text pass
 * through; HTML gets stripped to a Markdown-ish form (headings as #,
 * lists as -, code blocks fenced, paragraphs flat).
 *
 * Adversarial HTML (unbalanced tags, scripts, etc.) is degraded gracefully:
 * <script>/<style> bodies are dropped entirely; everything else flattens.
 */
export function fileToText(content: string, format: DocFormat): string {
  if (format !== 'html') return content;

  let s = content;
  // Drop entire script/style/svg blocks (their content is not readable)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Convert structural elements to markdown-flavored text BEFORE stripping
  // residual tags. Order matters — block-level transforms first.
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t: string) => `\n# ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t: string) => `\n## ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t: string) => `\n### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, t: string) => `\n#### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `- ${t.replace(/<[^>]+>/g, '').trim()}\n`);
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t: string) => `\n\`\`\`\n${t.replace(/<[^>]+>/g, '').trim()}\n\`\`\`\n\n`);
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${t.replace(/<[^>]+>/g, '').trim()}\``);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<\/(div|section|article|ul|ol|table|tr)>/gi, '\n');

  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');

  // Collapse runs of blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Allowed prefixes for `readDocFromPath`. Defenders against arbitrary file
 * reads (e.g. `/etc/passwd`) via /cardsfromdoc and /importdave Telegram
 * commands. Default: system temp dir + tenant data dir + (relaxed)
 * /tmp/bridge-coach so Brian can drop docs there for testing.
 *
 * Resolves at module-load time. Override via setDocAllowedPrefixes() for
 * tests.
 */
let _docAllowedPrefixes: string[] | null = null;

export function _setDocAllowedPrefixesForTests(prefixes: string[] | null): void {
  _docAllowedPrefixes = prefixes;
}

function defaultDocAllowedPrefixes(): string[] {
  const dataDir = process.env.CLAUDECLAW_DATA_DIR;
  const home = process.env.HOME;
  const prefixes = [os.tmpdir()];
  if (dataDir) prefixes.push(path.resolve(dataDir));
  // Conventional user-drop locations. Brian saves docs via Telegram to
  // ~/Downloads regularly; ~/Desktop is another common drop. The allow-
  // list is defense-in-depth against accidental /etc/passwd-style reads,
  // not a strict policy — these are normal user dirs on a single-user
  // Mac. Add a tenant-scoped override via DOC_ALLOWED_PREFIXES env if
  // needed.
  if (home) {
    prefixes.push(path.join(home, 'Downloads'));
    prefixes.push(path.join(home, 'Desktop'));
    prefixes.push(path.join(home, 'Documents'));
  }
  prefixes.push('/tmp/bridge-coach');
  // Comma-separated user override
  const extra = process.env.DOC_ALLOWED_PREFIXES;
  if (extra) {
    for (const p of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      prefixes.push(path.resolve(p));
    }
  }
  return prefixes;
}

const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB — Dave's HTML is 524 KB

/** Read a doc from a local path with format auto-detection. */
export function readDocFromPath(p: string): { content: string; format: DocFormat; title: string } {
  if (!path.isAbsolute(p)) {
    throw new Error(`document path must be absolute (got "${p}")`);
  }
  const resolved = path.resolve(p);
  if (resolved.includes('\0')) {
    throw new Error('document path contains null byte');
  }
  // Path must live under an allowed prefix. Prevents /etc/passwd-style
  // reads through the Telegram doc-adapter commands.
  const prefixes = _docAllowedPrefixes ?? defaultDocAllowedPrefixes();
  const ok = prefixes.some((prefix) => {
    const normalized = path.resolve(prefix);
    return resolved === normalized || resolved.startsWith(normalized + path.sep);
  });
  if (!ok) {
    throw new Error(`document path "${resolved}" is outside allowed prefixes [${prefixes.join(', ')}]`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: unknown) {
    throw new Error(`cannot stat document "${resolved}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`document path is not a regular file: "${resolved}"`);
  }
  if (stat.size > MAX_DOC_BYTES) {
    throw new Error(
      `document too large: ${stat.size} bytes (cap ${MAX_DOC_BYTES}). Split into smaller files.`,
    );
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const format = detectDocFormat(resolved);
  const title = path.basename(resolved);
  return { content, format, title };
}

/**
 * Generate cards from a document (path or in-memory content). Returns the
 * same result shape as cards-from-text.
 */
export async function generateCardsFromDocument(
  source: { content: string; format: DocFormat; title: string } | { path: string },
  opts: FromDocOpts,
): Promise<CardsFromTextResult> {
  const doc = 'path' in source ? readDocFromPath(source.path) : source;
  const text = fileToText(doc.content, doc.format);
  if (text.trim().length === 0) {
    throw new Error('document has no extractable text');
  }
  const sourceType = opts.sourceType ?? `doc-${doc.format}`;
  return generateCardsFromText(text, {
    ...opts,
    sourceType,
    sourceRef: opts.sourceRef ?? ('path' in source ? source.path : doc.title),
    sourceLabel: opts.sourceLabel ?? doc.title,
  });
}

/**
 * Send Telegram previews for cards generated from a document. Wraps
 * sendCardsFromText so the per-card preview + summary semantics are
 * identical regardless of source.
 */
export async function sendCardsFromDocument(
  ctx: Context,
  source: { content: string; format: DocFormat; title: string } | { path: string },
  opts: FromDocOpts,
): Promise<CardsFromTextResult> {
  const doc = 'path' in source ? readDocFromPath(source.path) : source;
  const text = fileToText(doc.content, doc.format);
  if (text.trim().length === 0) {
    await ctx.reply(`Document "${doc.title}" has no extractable text.`);
    return { accepted: [], rejected: [], duplicates: [], pendingIds: [] };
  }
  const sourceType = opts.sourceType ?? `doc-${doc.format}`;
  return sendCardsFromText(ctx, text, {
    ...opts,
    sourceType,
    sourceRef: opts.sourceRef ?? ('path' in source ? source.path : doc.title),
    sourceLabel: opts.sourceLabel ?? doc.title,
  });
}
