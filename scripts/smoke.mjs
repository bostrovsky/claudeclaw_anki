#!/usr/bin/env node
/**
 * scripts/smoke.mjs — actual smoke-test logic. Invoked by smoke.sh, which
 * sets the environment (GOOGLE_API_KEY, CLAUDECLAW_DATA_DIR, etc.) so we
 * don't have to source the tenant .env in JS.
 *
 * Each layer is a step; on first failure we exit non-zero with a clear
 * diagnostic. On success the script cleans up after itself: smoke-test
 * pending-card rows are deleted from the tenant DB, and any test note
 * we created in Anki is removed via AnkiConnect deleteNotes.
 */
import fs from 'node:fs';
import path from 'node:path';

const CLAW_ROOT = process.env.CLAW_ROOT;
const TENANT = process.env.SMOKE_TENANT;
const ANKI_CONNECT_URL = process.env.ANKI_CONNECT_URL || 'http://127.0.0.1:8765';
const ANKI_PROFILE = process.env.ANKI_PROFILE || '';

const TEST_DECK = 'ClaudeClawAnki::Smoke';
const SMOKE_SOURCE_TEXT = `A neuron has four main structural regions arranged in sequence. The dendrites are branching projections at one end that receive signals from other neurons. The cell body (soma) contains the nucleus and integrates incoming signals. The axon is a long projection extending from the soma that carries the action potential away. Signal flows in one direction: dendrites → soma → axon → terminals.`;

let passed = 0;
let failed = 0;
const stepResults = [];
function pass(step, detail) { passed++; stepResults.push({ step, ok: true, detail }); console.log(`✓ ${step}${detail ? ` — ${detail}` : ''}`); }
function fail(step, detail) { failed++; stepResults.push({ step, ok: false, detail }); console.log(`✗ ${step}\n  ${detail}`); }

// Dynamic imports against the built dist so we exercise the same code path
// the running bot uses, not the source.
const text = await import(path.join(CLAW_ROOT, 'dist', 'anki-adapters', 'text.js'));
const pending = await import(path.join(CLAW_ROOT, 'dist', 'anki-pending.js'));
const render = await import(path.join(CLAW_ROOT, 'dist', 'canvas-render.js'));
const dbMod = await import(path.join(CLAW_ROOT, 'dist', 'db.js'));
const core = await import(path.join(CLAW_ROOT, 'dist', 'anki-mcp-core.js'));

// ── Step 1: AnkiConnect reachable ────────────────────────────────────
let ankiOk = false;
let ankiVersion = null;
try {
  const resp = await fetch(ANKI_CONNECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'version', version: 6 }),
  });
  const j = await resp.json();
  if (typeof j.result === 'number') {
    ankiVersion = j.result;
    ankiOk = true;
    pass('Anki Desktop + AnkiConnect reachable', `AnkiConnect v${ankiVersion}`);
  } else {
    fail('AnkiConnect responded with no version number', JSON.stringify(j));
  }
} catch (err) {
  fail('AnkiConnect unreachable', `${err.message}\n  Is Anki Desktop running? Is the AnkiConnect addon (#2055492159) installed?`);
}

// ── Step 2: Init the tenant DB + verify schema ───────────────────────
try {
  dbMod.initDatabase();
  const db = dbMod.getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('anki_pending_cards', 'anki_card_meta', 'pending_doc_imports')`).all().map((r) => r.name);
  if (tables.length === 3) {
    pass('Schema migration applied', tables.join(', '));
  } else {
    fail('Schema migration incomplete', `Found tables: [${tables.join(', ')}] — expected all of anki_pending_cards, anki_card_meta, pending_doc_imports.\n  Re-run: sqlite3 ${process.env.CLAUDECLAW_DATA_DIR}/store/claudeclaw.db < migrations/schema.sql`);
  }
} catch (err) {
  fail('DB init failed', err.message);
}

// ── Step 3: Set up core for the pending module + Step 4: Generate cards ──
try {
  const stubFetch = ankiOk ? fetch : (async () => new Response('{}', { status: 502 }));
  const ankiCore = core.createCore({
    ankiConnectUrl: ANKI_CONNECT_URL,
    defaultProfile: ANKI_PROFILE,
    defaultAgentId: 'main',
    fetchFn: stubFetch,
  });
  pending._setCoreForTests(ankiCore);
  pending._clearStockModelCacheForTests();
} catch (err) {
  fail('Anki core setup failed', err.message);
}

let cardResult = null;
try {
  const t0 = Date.now();
  cardResult = await text.generateCardsFromText(SMOKE_SOURCE_TEXT, {
    deck: TEST_DECK,
    sourceLabel: 'Smoke test source',
    sourceType: 'text-paste',
    maxCards: 3,
    agentId: 'main',
    chatId: 'smoke',
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (cardResult.accepted.length > 0) {
    pass('Gemini card generation', `${cardResult.accepted.length} cards in ${elapsed}s (${cardResult.rejected.length} rejected, ${cardResult.duplicates.length} duplicates)`);
  } else if (cardResult.duplicates.length > 0) {
    pass('Gemini card generation (all duplicates)', `Smoke test already ran — ${cardResult.duplicates.length} duplicates skipped. Card pipeline works.`);
  } else {
    fail('Gemini returned no usable cards', `Accepted: 0, Rejected: ${cardResult.rejected.length}\n  First rejection: ${JSON.stringify(cardResult.rejected[0] ?? {})}`);
  }
} catch (err) {
  fail('Gemini card generation threw', `${err.message}\n  Check GOOGLE_API_KEY in your tenant's .env`);
}

// ── Step 5: Canvas preview render (PNG via Playwright) ───────────────
let renderedPngPath = null;
if (cardResult && cardResult.pendingIds.length > 0) {
  try {
    const card = pending.getPendingCard(cardResult.pendingIds[0]);
    const html = pending.renderPendingPreviewHtml(card, { index: 1, total: cardResult.pendingIds.length });
    const png = await render.renderHtmlToPng(html);
    if (png && fs.existsSync(png)) {
      const size = fs.statSync(png).size;
      if (size > 2000) {
        renderedPngPath = png;
        pass('Canvas preview rendered to PNG', `${(size / 1024).toFixed(0)} KB at ${png}`);
      } else {
        fail('Canvas preview PNG suspiciously small', `${size} bytes at ${png}`);
      }
    } else {
      fail('Canvas preview render returned null', 'renderHtmlToPng() returned null — is Playwright chromium installed? Run `npx playwright install chromium`.');
    }
  } catch (err) {
    fail('Canvas preview render threw', err.message);
  }
}

// ── Step 6: AnkiConnect addNote + deleteNotes round-trip ─────────────
let testNoteId = null;
if (ankiOk && ANKI_PROFILE) {
  try {
    // Ensure profile is active
    await fetch(ANKI_CONNECT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'loadProfile', version: 6, params: { name: ANKI_PROFILE } }),
    });
    // Ensure the deck exists
    await fetch(ANKI_CONNECT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'createDeck', version: 6, params: { deck: TEST_DECK } }),
    });
    // Use a built-in model that always exists (Basic) so we don't have to also
    // verify model bootstrap inside the smoke test. The user's real bot will
    // bootstrap ClaudeClaw Basic Rich on first card approval.
    const addResp = await fetch(ANKI_CONNECT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'addNote', version: 6,
        params: {
          note: {
            deckName: TEST_DECK,
            modelName: 'Basic',
            fields: { Front: `Smoke test ${Date.now()}`, Back: 'This note will be deleted by the smoke test.' },
            tags: ['claudeclaw-smoke'],
          },
        },
      }),
    });
    const addJson = await addResp.json();
    if (addJson.result && !addJson.error) {
      testNoteId = addJson.result;
      pass('AnkiConnect addNote round-trip', `noteId ${testNoteId}`);
      // Clean up — delete the note
      const delResp = await fetch(ANKI_CONNECT_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteNotes', version: 6, params: { notes: [testNoteId] } }),
      });
      const delJson = await delResp.json();
      if (!delJson.error) {
        pass('AnkiConnect deleteNotes cleanup', `removed ${testNoteId}`);
      } else {
        fail('Failed to delete smoke-test note', `noteId ${testNoteId} — clean up manually in Anki: ${delJson.error}`);
      }
    } else {
      fail('AnkiConnect addNote failed', addJson.error || 'unknown');
    }
  } catch (err) {
    fail('AnkiConnect round-trip threw', err.message);
  }
} else if (!ANKI_PROFILE) {
  console.log('⚠ Skipping AnkiConnect addNote test — ANKI_PROFILE not set in tenant .env');
} else {
  console.log('⚠ Skipping AnkiConnect addNote test — AnkiConnect unreachable');
}

// ── Step 7: Cleanup smoke-test pending rows ──────────────────────────
try {
  const db = dbMod.getDb();
  const result = db.prepare(`DELETE FROM anki_pending_cards WHERE deck = ?`).run(TEST_DECK);
  if (result.changes > 0) {
    pass(`Cleanup: removed ${result.changes} smoke-test pending row${result.changes === 1 ? '' : 's'}`);
  }
  // Also remove the temp PNG
  if (renderedPngPath && fs.existsSync(renderedPngPath)) {
    fs.unlinkSync(renderedPngPath);
  }
} catch (err) {
  console.log(`⚠ Cleanup of pending rows failed (non-fatal): ${err.message}`);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (failed === 0) {
  console.log(`✓ All ${passed} checks passed. ClaudeClaw Anki is installed and working.`);
  console.log('');
  console.log('Try it in Telegram:');
  console.log('  /card_help                    — full reference for every card command');
  console.log('  /cardsfromtext <deck>\\n<text> — generate cards from pasted text');
  console.log('  /cardsfromvideo <url> <deck>  — generate cards from a YouTube video');
  console.log('  /importdoc <abs-path>         — import a local MD/HTML/TXT file');
  process.exit(0);
} else {
  console.log(`✗ ${failed} of ${passed + failed} checks failed.`);
  console.log('');
  console.log('Re-read the failure messages above. Common fixes:');
  console.log('  - Anki Desktop not running: launch it');
  console.log('  - AnkiConnect missing: Tools → Add-ons → Get Add-ons → paste 2055492159 → Restart');
  console.log('  - Playwright chromium missing: npx playwright install chromium');
  console.log('  - Schema missing: bash claudeclaw_anki/install.sh');
  process.exit(1);
}
