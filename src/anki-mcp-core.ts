/**
 * ClaudeClaw Anki MCP — testable core.
 *
 * Holds the HTTP wrappers, profile-switch logic, sync orchestration, and tool
 * handler factory used by the stdio entry-point at ./anki-mcp.ts. Lives in a
 * separate module so unit tests can exercise this surface without triggering
 * the top-level `await server.connect(transport)` in the entry-point.
 *
 * Pure HTTP — does NOT touch claudeclaw.db. The caller is responsible for
 * recording anki_card_meta provenance after a successful add_note.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const ANKI_CONNECT_VERSION = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // most calls are fast
// Sync and importPackage routinely exceed 30s for large decks / first sync after import.
// 5 min keeps the AbortController quiet during legitimate long syncs (M5 fix).
const LONG_OP_TIMEOUT_MS = 300_000;
const HEALTH_RETRIES = 3;
const HEALTH_RETRY_TIMEOUT_MS = 2_000;
const MEDIA_MAX_BASE64_BYTES = 10_000_000; // ~7.5MB binary post-decode (M1 fix)

export interface AnkiConnectResponse<T = unknown> {
  result: T | null;
  error: string | null;
}

export interface AnkiCoreConfig {
  ankiConnectUrl: string;
  defaultProfile: string;
  /**
   * Story 9: identifies which tenant's agent the MCP is acting on behalf of.
   * Used as the fallback agent_id for the propose/auto-import card tools so
   * cards land in the right per-agent pending queue. Plumbed through from
   * the MCP host's env (CLAUDECLAW_AGENT_ID). Defaults to 'main' if unset.
   */
  defaultAgentId?: string;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override default per-call timeout. */
  defaultTimeoutMs?: number;
  /**
   * If set, importPackage paths must resolve under one of these absolute prefixes
   * (typically the tenant's data dir + os.tmpdir()). When unset, only basic
   * validation runs (must be absolute, must exist, must end in .apkg).
   */
  importPathAllowedPrefixes?: string[];
  /** Stat function — overridable for tests. Default: fs.statSync. */
  statSync?: (p: string) => { isFile(): boolean };
}

export interface AnkiCore {
  ankiCall<T>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  ensureProfile(profile: string): Promise<void>;
  syncSafe(profile: string): Promise<{ ok: boolean; error?: string }>;
  /** Serializes profile-dependent operations to prevent cross-tenant race (P1 fix). */
  withProfileLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Validates an importPackage path. Throws a structured error on rejection (P3 fix). */
  validateImportPath(p: string): void;
  config: Required<Omit<AnkiCoreConfig, 'fetchFn' | 'defaultTimeoutMs' | 'importPathAllowedPrefixes' | 'statSync' | 'defaultAgentId'>> & {
    fetchFn: typeof fetch;
    defaultTimeoutMs: number;
    importPathAllowedPrefixes: string[];
    statSync: (p: string) => { isFile(): boolean };
    defaultAgentId: string;
  };
}

export function createCore(config: AnkiCoreConfig): AnkiCore {
  const fetchFn = config.fetchFn ?? fetch;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const importPathAllowedPrefixes = config.importPathAllowedPrefixes ?? [];
  const statSync = config.statSync ?? ((p: string) => fs.statSync(p));
  const cfg = {
    ankiConnectUrl: config.ankiConnectUrl,
    defaultProfile: config.defaultProfile,
    defaultAgentId: config.defaultAgentId ?? 'main',
    fetchFn,
    defaultTimeoutMs,
    importPathAllowedPrefixes,
    statSync,
  };

  // ── Profile-switch mutex (P1 fix) ─────────────────────────────────────
  // AnkiConnect's loadProfile is global to the Anki Desktop process. With
  // multiple tenants potentially calling concurrently, ensureProfile +
  // dependent ankiCall must be atomic or one tenant can switch the profile
  // out from under another mid-operation. Single-flight queue serializes
  // all profile-dependent work through one in-process lock.
  let lockTail: Promise<unknown> = Promise.resolve();
  async function withProfileLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = lockTail;
    lockTail = slot;
    try {
      await prev;
    } catch {
      // Prior holder's failure shouldn't block us; we still got our slot.
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function ankiCall<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = defaultTimeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(cfg.ankiConnectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`AnkiConnect ${action}: transport error (${msg}). Is Anki Desktop running?`);
    }
    clearTimeout(timer);

    let body: AnkiConnectResponse<T>;
    try {
      body = (await res.json()) as AnkiConnectResponse<T>;
    } catch {
      throw new Error(
        `AnkiConnect ${action}: non-JSON response (HTTP ${res.status}). Likely something other than AnkiConnect is on this port.`,
      );
    }
    if (body.error) {
      throw new Error(`AnkiConnect ${action}: ${body.error}`);
    }
    return body.result as T;
  }

  async function ensureProfile(profile: string): Promise<void> {
    const wanted = profile || cfg.defaultProfile;
    if (!wanted) {
      throw new Error(
        'No Anki profile specified and no ANKI_PROFILE default set in tenant .env. ' +
          'Pass profile explicitly or add ANKI_PROFILE=<Brian|Jodie|Christine> to the tenant .env.',
      );
    }
    const active = await ankiCall<string>('getActiveProfile');
    if (active === wanted) return;

    await ankiCall<null>('loadProfile', { name: wanted });

    // M6 fix: AnkiConnect's loadProfile returns null on success but can also
    // resolve null when Anki is mid-startup and the switch didn't actually
    // happen. Verify by re-querying active profile and assert it matches.
    const after = await ankiCall<string>('getActiveProfile');
    if (after !== wanted) {
      throw new Error(
        `loadProfile('${wanted}') did not switch — active is still '${after}'. ` +
          'Is Anki Desktop mid-startup? Wait for it to settle and retry.',
      );
    }
  }

  // P4 fix: only the sync() HTTP call is "soft." ensureProfile errors
  // (no profile configured, loadProfile failed) MUST escape so callers
  // don't operate against the wrong profile.
  async function syncSafe(profile: string): Promise<{ ok: boolean; error?: string }> {
    await ensureProfile(profile);
    try {
      await ankiCall<null>('sync', {}, LONG_OP_TIMEOUT_MS);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // P3 fix: importPackage path validation. Defends against path traversal
  // and cross-tenant file access. Hard rules: absolute path, exists, is a
  // file, ends in .apkg. Soft rule (when configured): must resolve under
  // one of importPathAllowedPrefixes.
  function validateImportPath(p: string): void {
    if (typeof p !== 'string' || !p) {
      throw new Error('importPackage: path is required');
    }
    if (!path.isAbsolute(p)) {
      throw new Error(`importPackage: path must be absolute (got "${p}")`);
    }
    const resolved = path.resolve(p);
    if (resolved.includes('\0')) {
      throw new Error('importPackage: path contains null byte');
    }
    if (!resolved.endsWith('.apkg')) {
      throw new Error(`importPackage: only .apkg files allowed (got "${path.basename(resolved)}")`);
    }
    let stat: { isFile(): boolean };
    try {
      stat = statSync(resolved);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`importPackage: cannot stat path "${resolved}": ${msg}`);
    }
    if (!stat.isFile()) {
      throw new Error(`importPackage: path is not a regular file: "${resolved}"`);
    }
    if (importPathAllowedPrefixes.length > 0) {
      const ok = importPathAllowedPrefixes.some((prefix) => {
        const normalized = path.resolve(prefix);
        return resolved === normalized || resolved.startsWith(normalized + path.sep);
      });
      if (!ok) {
        throw new Error(
          `importPackage: path "${resolved}" is outside the allowed prefixes ` +
            `[${importPathAllowedPrefixes.join(', ')}]`,
        );
      }
    }
  }

  return { ankiCall, ensureProfile, syncSafe, withProfileLock, validateImportPath, config: cfg };
}

// ───────────────────────────────────────────────────────────────────────────
// Tool argument types
// ───────────────────────────────────────────────────────────────────────────

interface ProfileArg { profile?: string }
interface CreateDeckArgs extends ProfileArg { deck: string }
interface CreateModelArgs extends ProfileArg {
  modelName: string;
  inOrderFields: string[];
  css?: string;
  isCloze?: boolean;
  cardTemplates: Array<{ Name?: string; Front: string; Back: string }>;
}
interface AddNoteArgs extends ProfileArg {
  deck: string;
  model: string;
  fields: Record<string, string>;
  tags?: string[];
  options?: { allowDuplicate?: boolean; duplicateScope?: string };
}
interface UpdateNoteFieldsArgs extends ProfileArg {
  noteId: number;
  fields: Record<string, string>;
}
interface FindNotesArgs extends ProfileArg { query: string }
interface FindCardsArgs extends ProfileArg { query: string }
interface CardsInfoArgs extends ProfileArg { cards: number[] }
interface AnswerCardsArgs extends ProfileArg {
  answers: Array<{ cardId: number; ease: 1 | 2 | 3 | 4 }>;
}
interface StoreMediaFileArgs extends ProfileArg {
  filename: string;
  data: string; // base64
}
interface ImportPackageArgs extends ProfileArg { path: string }
interface SyncArgs extends ProfileArg {
  // intentionally empty — type marker for sync's lone optional profile arg
  _?: never;
}

function asArgs<T>(args: unknown): T {
  return (args as T) ?? ({} as T);
}

function getProfile(args: ProfileArg, defaultProfile: string): string {
  return args.profile || defaultProfile;
}

// ───────────────────────────────────────────────────────────────────────────
// Tool list
// ───────────────────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'anki_health',
    description:
      'Ping AnkiConnect and report status. Returns { version, activeProfile, ok }. Use this when Anki tools start failing to diagnose whether the issue is Anki Desktop down, the AnkiConnect addon missing, or a profile-load problem.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'anki_create_deck',
    description:
      'Create a deck (idempotent). Anki uses "::" as a hierarchy separator, so "Bridge::Conventions::Stayman" creates the full nested structure. Returns the new deck ID.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: "Anki profile name. Defaults to tenant's ANKI_PROFILE env." },
        deck: { type: 'string', description: 'Deck name; "::" creates hierarchy.' },
      },
      required: ['deck'],
    },
  },
  {
    name: 'anki_create_model',
    description:
      'Create a note model (card template) idempotently. Skip if a model with this name already exists in the profile. Provide fields in order (e.g. ["Front","Back","Source"]) and cardTemplates with Front/Back HTML referencing those fields like {{Front}}.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        modelName: { type: 'string' },
        inOrderFields: { type: 'array', items: { type: 'string' } },
        css: { type: 'string', description: 'CSS shared across all card templates of this model.' },
        isCloze: { type: 'boolean', description: 'True for cloze-deletion models.' },
        cardTemplates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              Name: { type: 'string' },
              Front: { type: 'string' },
              Back: { type: 'string' },
            },
            required: ['Front', 'Back'],
          },
        },
      },
      required: ['modelName', 'inOrderFields', 'cardTemplates'],
    },
  },
  {
    name: 'anki_propose_cards_from_text',
    description:
      'Generate Anki cards from a chunk of source text via Gemini, validate them against the archetype menu, dedup against previously-approved cards, and write them to the pending queue. Returns counts + pending IDs. The user reviews via /pending and approves through the Canvas preview gate. Use this for agent-driven research → cards flows. The agent should pre-synthesize source content (NOT dump raw web-search results) and pick a deck name (e.g. "Anatomy::TCellReceptor").',
    inputSchema: {
      type: 'object',
      properties: {
        deck: { type: 'string', description: 'Target deck. Created lazily on approve. Use "::" for hierarchy.' },
        sourceText: { type: 'string', description: 'Synthesized source content. The LLM produces cards FROM this text.' },
        sourceLabel: { type: 'string', description: 'Human-readable source description for citations (e.g. "Krebs cycle synthesis from Lehninger 7e + Khan Academy video").' },
        topicHint: { type: 'string', description: 'Optional narrowing passed to the card-gen LLM.' },
        maxCards: { type: 'number', description: 'Cap on cards produced. Default 6, max 12.' },
        sourceType: { type: 'string', description: 'Provenance tag (default "agent-research").' },
        agentId: { type: 'string', description: 'Overrides CLAUDECLAW_AGENT_ID env. Determines whose pending queue the cards land in.' },
      },
      required: ['deck', 'sourceText', 'sourceLabel'],
    },
  },
  {
    name: 'anki_auto_import_text',
    description:
      'Same as anki_propose_cards_from_text BUT auto-approves every generated card directly into Anki, bypassing the pending queue. Use this when the agent has high confidence and Brian/the user has already authorized the agent to commit cards (e.g. by saying "make me a Krebs deck and just commit it"). Returns counts + Anki note IDs. Failures don\'t roll back successes.',
    inputSchema: {
      type: 'object',
      properties: {
        deck: { type: 'string', description: 'Target deck. Created lazily. Use "::" for hierarchy.' },
        sourceText: { type: 'string', description: 'Synthesized source content. Cards are produced FROM this text.' },
        sourceLabel: { type: 'string', description: 'Human-readable source description for citations.' },
        topicHint: { type: 'string', description: 'Optional narrowing passed to the card-gen LLM.' },
        maxCards: { type: 'number', description: 'Cap on cards produced (1-12). Default 6.' },
        sourceType: { type: 'string', description: 'Provenance tag (default "agent-research").' },
        agentId: { type: 'string', description: 'Overrides CLAUDECLAW_AGENT_ID env. Determines whose cards these become.' },
      },
      required: ['deck', 'sourceText', 'sourceLabel'],
    },
  },
  {
    name: 'anki_add_note',
    description:
      'Add a new note (which produces one or more cards depending on the model). Returns the new noteId. Does NOT auto-record provenance — caller must write anki_card_meta row separately.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        deck: { type: 'string' },
        model: { type: 'string' },
        fields: {
          type: 'object',
          description: "Field name → content map. Field names must match the model's inOrderFields.",
          additionalProperties: { type: 'string' },
        },
        tags: { type: 'array', items: { type: 'string' } },
        options: {
          type: 'object',
          properties: {
            allowDuplicate: { type: 'boolean' },
            duplicateScope: { type: 'string', description: 'deck | collection (default: deck)' },
          },
        },
      },
      required: ['deck', 'model', 'fields'],
    },
  },
  {
    name: 'anki_update_note_fields',
    description:
      "Update the fields of an existing note WITHOUT resetting its review history. Use this when a source has changed but you want the tenant's FSRS schedule preserved. If content drift is large enough to reset learning, the caller should explicitly reset the card via a separate flow.",
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        noteId: { type: 'number' },
        fields: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['noteId', 'fields'],
    },
  },
  {
    name: 'anki_find_notes',
    description:
      'Search notes using Anki\'s search syntax. Returns an array of noteIds. Examples: "deck:Bridge::Conventions", "tag:stayman", "added:7" (added in last 7 days).',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        query: { type: 'string', description: "Anki search syntax." },
      },
      required: ['query'],
    },
  },
  {
    name: 'anki_find_cards',
    description:
      'Search cards (one note can produce multiple cards). Useful for review-state queries like "is:due", "prop:lapses>=3", "is:leech". Returns array of cardIds.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'anki_cards_info',
    description:
      'Get full info for cards by ID: fields, model, interval, due, lapses, ease, reps. Used by the review surface to render cards and by the diagnostic loop to identify struggle patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        cards: { type: 'array', items: { type: 'number' } },
      },
      required: ['cards'],
    },
  },
  {
    name: 'anki_answer_cards',
    description:
      "Submit review answers without the Anki GUI. Ease scale: 1=Again, 2=Hard, 3=Good, 4=Easy. Anki's FSRS scheduler updates each card's state. Used by the Telegram review surface.",
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cardId: { type: 'number' },
              ease: { type: 'number', description: '1 (Again) | 2 (Hard) | 3 (Good) | 4 (Easy)' },
            },
            required: ['cardId', 'ease'],
          },
        },
      },
      required: ['answers'],
    },
  },
  {
    name: 'anki_store_media_file',
    description:
      "Upload a media file (image/audio) into the profile's collection.media folder. Pass content as base64. After storing, reference it in card HTML as <img src=\"filename.png\"> or [sound:filename.mp3].",
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        filename: { type: 'string' },
        data: { type: 'string', description: 'Base64-encoded file content.' },
      },
      required: ['filename', 'data'],
    },
  },
  {
    name: 'anki_import_package',
    description:
      'Import a .apkg file at the given absolute path into the profile. Use when a tenant points at an AnkiWeb shared deck URL or sends a .apkg attachment — caller downloads to a temp path first, then calls this. After import, call anki_sync to push to AnkiWeb.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
        path: { type: 'string', description: 'Absolute filesystem path to a .apkg file on the Anki host.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'anki_sync',
    description:
      'Trigger AnkiWeb sync for the profile. Used as _syncBefore (pull AnkiWeb → local before reading review state) and _syncAfter (push local → AnkiWeb after writes). Sync failures return { ok: false, error } rather than throwing — caller decides whether to proceed against last-known state.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string' },
      },
    },
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Tool dispatcher (testable)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Health is the only tool that bypasses the profile-switch mutex.
 * Diagnostics should be fast and not block behind in-flight tool calls.
 */
async function dispatchHealth(
  core: AnkiCore,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { ankiCall, config } = core;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= HEALTH_RETRIES; attempt++) {
    try {
      const version = await ankiCall<number>('version', {}, HEALTH_RETRY_TIMEOUT_MS);
      const activeProfile = await ankiCall<string>('getActiveProfile', {}, HEALTH_RETRY_TIMEOUT_MS);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: true, version, activeProfile, ankiConnectUrl: config.ankiConnectUrl },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok: false,
            error: lastError,
            ankiConnectUrl: config.ankiConnectUrl,
            hint: 'Is Anki Desktop running? Is the AnkiConnect addon (#2055492159) installed?',
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Profile-dependent dispatch. Caller MUST already hold core.withProfileLock
 * (P1 fix). Doing ensureProfile + the actual ankiCall inside a single lock
 * guarantees no other tenant can flip the active profile mid-operation.
 */
async function dispatchLocked(
  core: AnkiCore,
  name: string,
  rawArgs: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { ankiCall, ensureProfile, syncSafe, validateImportPath, config } = core;

  if (name === 'anki_create_deck') {
    const args = asArgs<CreateDeckArgs>(rawArgs);
    if (!args.deck) throw new Error('deck is required');
    await ensureProfile(getProfile(args, config.defaultProfile));
    const deckId = await ankiCall<number>('createDeck', { deck: args.deck });
    return { content: [{ type: 'text', text: JSON.stringify({ deckId }) }] };
  }

  if (name === 'anki_create_model') {
    const args = asArgs<CreateModelArgs>(rawArgs);
    if (!args.modelName) throw new Error('modelName is required');
    if (!args.inOrderFields?.length) throw new Error('inOrderFields is required');
    if (!args.cardTemplates?.length) throw new Error('cardTemplates is required');
    await ensureProfile(getProfile(args, config.defaultProfile));
    const existing = await ankiCall<string[]>('modelNames');
    if (existing.includes(args.modelName)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ created: false, reason: 'model exists', modelName: args.modelName }),
          },
        ],
      };
    }
    const modelId = await ankiCall<number>('createModel', {
      modelName: args.modelName,
      inOrderFields: args.inOrderFields,
      css: args.css,
      isCloze: args.isCloze ?? false,
      cardTemplates: args.cardTemplates,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ created: true, modelId, modelName: args.modelName }) }],
    };
  }

  if (name === 'anki_add_note') {
    const args = asArgs<AddNoteArgs>(rawArgs);
    if (!args.deck) throw new Error('deck is required');
    if (!args.model) throw new Error('model is required');
    if (!args.fields) throw new Error('fields is required');
    const profile = getProfile(args, config.defaultProfile);
    await ensureProfile(profile);
    const notePayload: Record<string, unknown> = {
      deckName: args.deck,
      modelName: args.model,
      fields: args.fields,
      tags: args.tags ?? [],
    };
    if (args.options !== undefined) notePayload.options = args.options;
    const noteId = await ankiCall<number>('addNote', { note: notePayload });
    const syncResult = await syncSafe(profile);
    return { content: [{ type: 'text', text: JSON.stringify({ noteId, sync: syncResult }) }] };
  }

  if (name === 'anki_update_note_fields') {
    const args = asArgs<UpdateNoteFieldsArgs>(rawArgs);
    if (typeof args.noteId !== 'number') throw new Error('noteId is required (must be a number)');
    if (!args.fields) throw new Error('fields is required');
    const profile = getProfile(args, config.defaultProfile);
    await ensureProfile(profile);
    await ankiCall<null>('updateNoteFields', { note: { id: args.noteId, fields: args.fields } });
    const syncResult = await syncSafe(profile);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sync: syncResult }) }] };
  }

  if (name === 'anki_find_notes') {
    const args = asArgs<FindNotesArgs>(rawArgs);
    if (!args.query) throw new Error('query is required');
    const profile = getProfile(args, config.defaultProfile);
    // M2 fix: capture sync result so caller can tell when reads are stale.
    const syncResult = await syncSafe(profile);
    // ensureProfile already ran inside syncSafe; no extra call needed.
    const noteIds = await ankiCall<number[]>('findNotes', { query: args.query });
    return { content: [{ type: 'text', text: JSON.stringify({ noteIds, sync: syncResult }) }] };
  }

  if (name === 'anki_find_cards') {
    const args = asArgs<FindCardsArgs>(rawArgs);
    if (!args.query) throw new Error('query is required');
    const profile = getProfile(args, config.defaultProfile);
    const syncResult = await syncSafe(profile); // M2 fix
    const cardIds = await ankiCall<number[]>('findCards', { query: args.query });
    return { content: [{ type: 'text', text: JSON.stringify({ cardIds, sync: syncResult }) }] };
  }

  if (name === 'anki_cards_info') {
    const args = asArgs<CardsInfoArgs>(rawArgs);
    if (!Array.isArray(args.cards) || args.cards.length === 0) {
      throw new Error('cards array is required');
    }
    const profile = getProfile(args, config.defaultProfile);
    // P2 fix: cards_info is a read path. Sync before reading so AnkiMobile-side
    // state changes (e.g. ratings recorded offline) flow through.
    const syncResult = await syncSafe(profile);
    const info = await ankiCall<unknown[]>('cardsInfo', { cards: args.cards });
    return { content: [{ type: 'text', text: JSON.stringify({ cards: info, sync: syncResult }) }] };
  }

  if (name === 'anki_answer_cards') {
    const args = asArgs<AnswerCardsArgs>(rawArgs);
    if (!args.answers?.length) throw new Error('answers array is required');
    const profile = getProfile(args, config.defaultProfile);
    await ensureProfile(profile);
    const results = await ankiCall<boolean[]>('answerCards', { answers: args.answers });
    const syncResult = await syncSafe(profile);
    return { content: [{ type: 'text', text: JSON.stringify({ results, sync: syncResult }) }] };
  }

  if (name === 'anki_store_media_file') {
    const args = asArgs<StoreMediaFileArgs>(rawArgs);
    if (!args.filename) throw new Error('filename is required');
    if (!args.data) throw new Error('data (base64) is required');
    if (typeof args.data !== 'string') throw new Error('data must be a base64 string');
    // M1 fix: cap base64 payload size. Caller should chunk or downsample.
    if (args.data.length > MEDIA_MAX_BASE64_BYTES) {
      throw new Error(
        `media file too large: ${args.data.length} base64 bytes (max ${MEDIA_MAX_BASE64_BYTES}). ` +
          `Resize or compress before uploading.`,
      );
    }
    // Defensive filename sanitization — strip path components so a caller
    // can't escape the collection.media dir via "../foo.png".
    const safeFilename = path.basename(args.filename);
    if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
      throw new Error(`invalid filename after sanitization: "${args.filename}"`);
    }
    await ensureProfile(getProfile(args, config.defaultProfile));
    const storedName = await ankiCall<string>('storeMediaFile', {
      filename: safeFilename,
      data: args.data,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ filename: storedName }) }] };
  }

  if (name === 'anki_import_package') {
    const args = asArgs<ImportPackageArgs>(rawArgs);
    if (!args.path) throw new Error('path is required');
    // P3 fix: validate path before forwarding to AnkiConnect.
    validateImportPath(args.path);
    const profile = getProfile(args, config.defaultProfile);
    await ensureProfile(profile);
    // M5 fix: importPackage can take minutes on large decks with media.
    const ok = await ankiCall<boolean>('importPackage', { path: args.path }, LONG_OP_TIMEOUT_MS);
    const syncResult = await syncSafe(profile);
    return { content: [{ type: 'text', text: JSON.stringify({ imported: ok, sync: syncResult }) }] };
  }

  if (name === 'anki_sync') {
    const args = asArgs<SyncArgs>(rawArgs);
    const profile = getProfile(args, config.defaultProfile);
    const result = await syncSafe(profile);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

interface ProposeFromTextArgs {
  deck?: string;
  sourceText?: string;
  sourceLabel?: string;
  topicHint?: string;
  maxCards?: number;
  sourceType?: string;
  agentId?: string;
}

/**
 * Story 9: agent-driven card generation. Wraps generateCardsFromText.
 * Runs OUTSIDE withProfileLock because the underlying approve step (used
 * by anki_auto_import_text) takes the lock per-card via approvePending,
 * and double-locking would deadlock the single-flight queue.
 *
 * Dynamic import of the text adapter resolves the circular dependency
 * (anki-mcp-core ← anki-pending → anki-mcp-core) at runtime.
 */
async function dispatchProposeCardsFromText(
  core: AnkiCore,
  rawArgs: unknown,
  mode: 'propose' | 'auto-import',
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const args = asArgs<ProposeFromTextArgs>(rawArgs);
  if (!args.deck) throw new Error('deck is required');
  if (!args.sourceText || args.sourceText.trim().length === 0) {
    throw new Error('sourceText is required and must be non-empty');
  }
  if (!args.sourceLabel) throw new Error('sourceLabel is required');

  // P3 fix (Story 9 review): validate maxCards bounds at the MCP layer
  // rather than silently clamping at the prompt layer.
  if (args.maxCards !== undefined && (args.maxCards < 1 || args.maxCards > 12)) {
    throw new Error(`maxCards must be between 1 and 12 (got ${args.maxCards})`);
  }

  // P1 fix (Story 9 review): the MCP subprocess inherits CLAUDECLAW_AGENT_ID
  // via the host's env config (see settings.json). Use it as the fallback so
  // each tenant's MCP server tags cards with their agent id, not 'main'.
  const agentId =
    args.agentId ?? process.env.CLAUDECLAW_AGENT_ID ?? core.config.defaultAgentId;

  const { generateCardsFromText } = await import('./anki-adapters/text.js');
  const result = await generateCardsFromText(args.sourceText, {
    deck: args.deck,
    sourceLabel: args.sourceLabel,
    sourceType: args.sourceType ?? 'agent-research',
    topicHint: args.topicHint,
    maxCards: args.maxCards ?? 6,
    agentId,
  });

  if (mode === 'propose') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            proposed: result.accepted.length,
            pendingIds: result.pendingIds,
            duplicates: result.duplicates.length,
            rejected: result.rejected.length,
            batchId: result.batchId,
          }),
        },
      ],
    };
  }

  // auto-import: approve each pending card. Failures don't roll back
  // successes — each card's approvePending claim is atomic.
  const { approvePending } = await import('./anki-pending.js');
  const ankiNoteIds: number[] = [];
  let failed = 0;
  const failures: Array<{ id: number; error: string }> = [];
  for (const id of result.pendingIds) {
    try {
      const out = await approvePending(id);
      ankiNoteIds.push(out.ankiNoteId);
    } catch (err: unknown) {
      failed++;
      failures.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          imported: ankiNoteIds.length,
          ankiNoteIds,
          duplicates: result.duplicates.length,
          rejected: result.rejected.length,
          failed,
          failures: failures.length > 0 ? failures : undefined,
        }),
      },
    ],
  };
}

export async function dispatchTool(
  core: AnkiCore,
  name: string,
  rawArgs: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    // anki_health is a fast-path: no profile dependency, no lock. Lets
    // diagnostics succeed even when the queue is jammed behind a slow
    // sync or importPackage.
    if (name === 'anki_health') {
      return await dispatchHealth(core);
    }
    // Story 9 fast-paths: card generation tools delegate to the text
    // adapter, which manages its own DB writes and takes the profile
    // lock per-card during approvePending. Running these inside the
    // wrapper lock would deadlock the inner approve calls.
    if (name === 'anki_propose_cards_from_text') {
      return await dispatchProposeCardsFromText(core, rawArgs, 'propose');
    }
    if (name === 'anki_auto_import_text') {
      return await dispatchProposeCardsFromText(core, rawArgs, 'auto-import');
    }
    return await core.withProfileLock(() => dispatchLocked(core, name, rawArgs));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${msg}` }],
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Server factory (used by the stdio entry-point AND by tests)
// ───────────────────────────────────────────────────────────────────────────

export function createServer(core: AnkiCore): Server {
  const server = new Server(
    { name: 'claudeclaw-anki', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return dispatchTool(core, req.params.name, req.params.arguments);
  });

  return server;
}
