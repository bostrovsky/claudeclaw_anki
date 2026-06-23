#!/usr/bin/env node
/**
 * ClaudeClaw Anki MCP — stdio entry-point.
 *
 * Stdio-based MCP exposing AnkiConnect's HTTP API to agents. Source-agnostic
 * plumbing: every tool takes a `profile` argument (e.g. "Brian" / "Jodie" /
 * "Christine") so the wrapper can issue loadProfile when the active profile
 * differs from the requested one.
 *
 * The MCP itself is pure HTTP — it does NOT touch claudeclaw.db. Metadata
 * writes (anki_card_meta provenance rows) belong to the calling agent code;
 * the MCP only returns the AnkiConnect result so the caller can record
 * provenance.
 *
 * AnkiConnect must be reachable at ANKI_CONNECT_URL (default
 * http://127.0.0.1:8765). That requires Anki Desktop running on the host
 * with the AnkiConnect addon (#2055492159) installed.
 *
 * Reads tenant .env from CLAUDECLAW_DATA_DIR. Optional env vars:
 *   - ANKI_CONNECT_URL  (default "http://127.0.0.1:8765")
 *   - ANKI_PROFILE      (default profile if tool call omits one)
 *
 * Testable logic lives in ./anki-mcp-core.ts so unit tests can exercise the
 * dispatcher without triggering this file's top-level `await server.connect`.
 */
import os from 'node:os';
import path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createCore, createServer } from './anki-mcp-core.js';
import { readEnvFile } from './env.js';

try {
  const env = readEnvFile(['ANKI_CONNECT_URL', 'ANKI_PROFILE']);
  const ANKI_CONNECT_URL =
    process.env.ANKI_CONNECT_URL || env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765';
  const DEFAULT_PROFILE = process.env.ANKI_PROFILE || env.ANKI_PROFILE || '';

  // P3 fix: scope importPackage paths to the tenant's data dir and the system
  // temp dir. CLAUDECLAW_DATA_DIR is set per-tenant in the launchd plist /
  // settings.json. If unset, only the temp dir is allowed.
  const dataDir = process.env.CLAUDECLAW_DATA_DIR;
  const importPathAllowedPrefixes = [
    os.tmpdir(),
    ...(dataDir ? [path.resolve(dataDir)] : []),
  ];

  // P1 fix (Story 9): plumb CLAUDECLAW_AGENT_ID through so the
  // propose/auto-import card tools default to the right tenant agent's
  // pending queue. The MCP host (settings.json) sets this env per tenant
  // alongside CLAUDECLAW_DATA_DIR.
  const DEFAULT_AGENT_ID = process.env.CLAUDECLAW_AGENT_ID || 'main';

  const core = createCore({
    ankiConnectUrl: ANKI_CONNECT_URL,
    defaultProfile: DEFAULT_PROFILE,
    defaultAgentId: DEFAULT_AGENT_ID,
    importPathAllowedPrefixes,
  });
  const server = createServer(core);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[anki-mcp] ready (url=${ANKI_CONNECT_URL}, defaultProfile=${DEFAULT_PROFILE || '<unset>'}, ` +
      `defaultAgentId=${DEFAULT_AGENT_ID}, importPaths=[${importPathAllowedPrefixes.join(', ')}])`,
  );
} catch (err: unknown) {
  // L8 fix: surface startup failures as a structured JSON line on stderr
  // before exiting. The MCP host's logs will show this clearly instead of
  // an opaque unhandled-rejection trace.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    JSON.stringify({
      event: 'startup_failed',
      mcp: 'claudeclaw-anki',
      error: msg,
      hint:
        'Common causes: CLAUDECLAW_DATA_DIR unset, .env missing ANKI_PROFILE, ' +
        'or AnkiConnect unreachable at ANKI_CONNECT_URL.',
    }),
  );
  process.exit(1);
}
