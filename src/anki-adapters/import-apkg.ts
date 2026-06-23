/**
 * .apkg deck importer.
 *
 * Inputs:
 *   - AnkiWeb shared-deck URL: ankiweb.net/shared/info/<id> or /shared/download/<id>
 *   - Direct .apkg URL anywhere on the web
 *   - Telegram-attached file already downloaded to a local path
 *
 * For URL inputs we stream-download to a tmp file (inside the system tmpdir,
 * which is allow-listed for importPackage validation), enforce an active byte
 * cap mid-stream (not just a post-write check), validate magic-bytes for a
 * zip signature, and call AnkiConnect's importPackage action. Sync runs
 * OUTSIDE the profile mutex so a 5-min AnkiWeb sync doesn't starve other
 * tenants' approval flows.
 *
 * Defends against:
 *   - SSRF: blocks RFC1918 / loopback / link-local / unique-local on URL and
 *     every redirect target (manual redirect handling, max 5).
 *   - Disk DoS: streams with active byte counter; aborts + unlinks past cap.
 *   - Wrong-content-type imports: checks zip magic bytes (PK\x03\x04) before
 *     handing the file to AnkiConnect.
 *
 * Optionally namespaces imported decks under a prefix (default 'Imported')
 * so Anki-from-elsewhere decks stay distinguishable from ClaudeClaw-
 * generated decks (Story 3 spec AC#3 / README deck taxonomy).
 *
 * Does NOT route through the pending-cards approval gate — the user is
 * explicitly installing a curated deck, not proposing card-by-card.
 */
import fs from 'node:fs';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

import { createCore, type AnkiCore } from '../anki-mcp-core.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

let _core: AnkiCore | null = null;

function getCore(): AnkiCore {
  if (_core) return _core;
  const env = readEnvFile(['ANKI_CONNECT_URL', 'ANKI_PROFILE']);
  const dataDir = process.env.CLAUDECLAW_DATA_DIR;
  _core = createCore({
    ankiConnectUrl:
      process.env.ANKI_CONNECT_URL || env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765',
    defaultProfile: process.env.ANKI_PROFILE || env.ANKI_PROFILE || '',
    importPathAllowedPrefixes: [os.tmpdir(), ...(dataDir ? [path.resolve(dataDir)] : [])],
  });
  return _core;
}

/** Test seam — inject a stub core. */
export function _setCoreForTests(core: AnkiCore | null): void {
  _core = core;
}

export interface ImportApkgOpts {
  /** Anki profile (defaults to core's defaultProfile). */
  profile?: string;
  /**
   * Remove the source file on completion (default: true if WE downloaded it,
   * false if caller provided a path — caller manages their own files).
   */
  cleanupTmp?: boolean;
  /**
   * Namespace imported decks under <namespace>::<original-deck-name>.
   * Defaults to 'Imported'. Pass an explicit empty string to skip renaming
   * (preserve the .apkg's internal deck structure as-is).
   */
  namespace?: string;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override DNS resolver for tests. */
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string }>>;
}

export interface ImportApkgResult {
  imported: boolean;
  localPath: string;
  syncOk: boolean;
  syncError?: string;
  /** New decks introduced by this import (after any namespace rename). */
  newDecks: string[];
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_REDIRECTS = 5;
const APKG_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP local-file header — .apkg is a zip
const DEFAULT_NAMESPACE = 'Imported';

const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IPV4_PATTERNS.some((rx) => rx.test(ip))) return true;
  // IPv6: loopback ::1, link-local fe80::/10, unique-local fc00::/7 (fc00-fdff prefix)
  if (ip === '::1' || ip === '::') return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1 etc) — strip and recurse
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateIp(v4mapped[1]);
  return false;
}

/**
 * Block private IPs on the initial URL and every redirect target.
 * Resolve hostname via DNS so a misbehaving host with a public A record
 * pointing at 127.0.0.1 still gets blocked. (DNS rebinding TOCTOU exists
 * but is mitigated by every-hop validation.)
 */
async function assertHostPublic(
  url: string,
  dnsLookup: (h: string) => Promise<Array<{ address: string }>>,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing non-http(s) URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip [..] brackets around IPv6
  // Direct IP literal?
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) {
      throw new Error(`refusing to fetch private/loopback host: ${host}`);
    }
    return;
  }
  // Hostname → DNS
  const records = await dnsLookup(host);
  if (records.length === 0) {
    throw new Error(`hostname ${host} did not resolve`);
  }
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error(`hostname ${host} resolves to private IP ${r.address}`);
    }
  }
}

/**
 * Translate an AnkiWeb shared-deck info URL to its direct download URL.
 * Other URL shapes (a raw .apkg link) are passed through unchanged.
 */
export function normalizeApkgUrl(url: string): string {
  const sharedInfo = url.match(/^https?:\/\/ankiweb\.net\/shared\/info\/(\d+)/i);
  if (sharedInfo) {
    return `https://ankiweb.net/shared/download/${sharedInfo[1]}`;
  }
  return url;
}

/**
 * Stream-download with active byte cap and SSRF protection.
 *
 * Returns the absolute tmp path on success. On any failure (network error,
 * cap exceeded, magic-byte check failed, etc.) cleans up the partial tmp
 * file and re-throws with a clear message.
 */
export async function downloadApkg(
  url: string,
  fetchFn: typeof fetch = fetch,
  dnsLookup: (h: string) => Promise<Array<{ address: string }>> = (h) =>
    dns.lookup(h, { all: true }),
): Promise<string> {
  let current = normalizeApkgUrl(url);
  let redirects = 0;
  let res: Response | undefined;

  // Manual redirect loop so we can validate each hop against the SSRF allowlist.
  // fetch's redirect:'follow' would hide intermediate targets from us.
  for (;;) {
    await assertHostPublic(current, dnsLookup);
    res = await fetchFn(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) {
        throw new Error(`HTTP ${res.status} redirect without Location header`);
      }
      if (++redirects > MAX_REDIRECTS) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      }
      current = new URL(next, current).toString();
      continue;
    }
    break;
  }

  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`refusing to download ${contentLength} bytes (cap ${MAX_DOWNLOAD_BYTES})`);
  }
  if (!res.body) {
    throw new Error('download had no response body');
  }

  const tmpName = `claudeclaw-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.apkg`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  // Active byte counter — abort + unlink immediately on overflow rather than
  // waiting for a post-write statSync. Captures the first 4 bytes for magic-
  // bytes validation since we have to inspect the stream anyway.
  let bytesWritten = 0;
  const firstBytes: Buffer[] = [];
  let firstBytesNeeded = 4;
  const fileStream = fs.createWriteStream(tmpPath);

  const counter = new Writable({
    write(chunk: Buffer, _enc, cb) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_DOWNLOAD_BYTES) {
        cb(new Error(`download exceeded cap ${MAX_DOWNLOAD_BYTES} bytes`));
        return;
      }
      if (firstBytesNeeded > 0) {
        const take = Math.min(firstBytesNeeded, chunk.length);
        firstBytes.push(chunk.subarray(0, take));
        firstBytesNeeded -= take;
      }
      fileStream.write(chunk, (err) => cb(err || null));
    },
    final(cb) {
      fileStream.end(cb);
    },
  });

  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, counter);
  } catch (err: unknown) {
    fs.unlink(tmpPath, () => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`download failed mid-stream: ${msg}`);
  }

  const magic = Buffer.concat(firstBytes).subarray(0, 4);
  if (magic.length < 4 || !magic.equals(APKG_MAGIC)) {
    fs.unlink(tmpPath, () => {});
    throw new Error(
      `downloaded file is not a valid .apkg (zip magic bytes missing — got ${magic.toString('hex')})`,
    );
  }

  return tmpPath;
}

/**
 * Import a .apkg into the tenant's Anki profile.
 *
 * `source` accepts:
 *   - "https?://..." — fetched to a tmp file, imported, tmp file removed
 *   - "/abs/path/..." — local path (must be absolute + readable)
 *
 * Post-import: optionally renames imported decks under a namespace prefix,
 * then triggers AnkiWeb sync (sync runs OUTSIDE the profile mutex so it
 * doesn't block concurrent approvals).
 *
 * Throws on validation failure or AnkiConnect errors. Sync is non-fatal.
 */
export async function importApkg(
  source: string,
  opts: ImportApkgOpts = {},
): Promise<ImportApkgResult> {
  const core = getCore();
  const profile = opts.profile || core.config.defaultProfile;
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const fetchFn = opts.fetchFn ?? fetch;
  const dnsLookup =
    opts.dnsLookup ?? ((h: string) => dns.lookup(h, { all: true }));

  let localPath: string;
  let weDownloaded = false;
  if (/^https?:\/\//i.test(source)) {
    localPath = await downloadApkg(source, fetchFn, dnsLookup);
    weDownloaded = true;
  } else if (path.isAbsolute(source)) {
    localPath = source;
  } else {
    throw new Error(`unsupported source "${source}" — must be http(s) URL or absolute path`);
  }

  const shouldCleanup = opts.cleanupTmp ?? weDownloaded;

  try {
    core.validateImportPath(localPath);

    // Snapshot pre-import deck list so we can identify newly-added decks.
    let preDecks: string[] = [];
    let imported = false;
    let newDecks: string[] = [];

    await core.withProfileLock(async () => {
      await core.ensureProfile(profile);
      preDecks = await core.ankiCall<string[]>('deckNames');
      imported = await core.ankiCall<boolean>('importPackage', { path: localPath }, 300_000);
      const postDecks = await core.ankiCall<string[]>('deckNames');
      const introduced = postDecks.filter((d) => !preDecks.includes(d));

      // Namespace rename: move each newly-introduced deck under <namespace>::
      // unless the namespace is empty (caller opted out) or the deck already
      // has our namespace prefix. AnkiConnect's `changeDeck` moves cards (not
      // notes — notes don't have a deck), so we resolve cards-per-new-deck.
      if (namespace && introduced.length > 0) {
        for (const deck of introduced) {
          if (deck.startsWith(`${namespace}::`)) {
            newDecks.push(deck);
            continue;
          }
          const targetDeck = `${namespace}::${deck}`;
          await core.ankiCall<null>('createDeck', { deck: targetDeck });
          const cardIds = await core.ankiCall<number[]>('findCards', { query: `"deck:${deck}"` });
          if (cardIds.length > 0) {
            await core.ankiCall<null>('changeDeck', { cards: cardIds, deck: targetDeck });
          }
          // Leave the now-empty original deck in place; Anki won't auto-delete it
          // and rmdir is risky if there are decks like "Default::Original" we
          // shouldn't touch. Caller can clean up manually if desired.
          newDecks.push(targetDeck);
        }
      } else {
        newDecks = introduced;
      }
    });

    // Sync OUTSIDE the lock so a slow AnkiWeb sync doesn't block other
    // tenants' approvals. Wait for sync to finish (best-effort).
    let syncOk = true;
    let syncError: string | undefined;
    try {
      await core.withProfileLock(async () => {
        await core.ensureProfile(profile);
      });
      await core.ankiCall<null>('sync', {}, 300_000);
    } catch (err: unknown) {
      syncOk = false;
      syncError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: syncError, localPath }, 'anki post-import sync failed');
    }

    return { imported, localPath, syncOk, syncError, newDecks };
  } finally {
    if (shouldCleanup) {
      fs.unlink(localPath, () => {});
    }
  }
}
