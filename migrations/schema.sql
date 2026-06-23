-- ClaudeClaw Anki — schema migration
--
-- Adds three tables to claudeclaw.db. All idempotent (CREATE TABLE IF NOT
-- EXISTS) and safe to re-run. Anki itself is the source of truth for card
-- content + FSRS state — these tables track metadata Anki doesn't:
--
--   anki_pending_cards    Cards awaiting user approval through Canvas
--                         previews. Drained on approve → addNote via
--                         AnkiConnect.
--
--   anki_card_meta        Provenance ledger of approved cards. Tracks
--                         which agent created the card, what source it
--                         came from (YouTube URL, doc, KB-ref), and a
--                         content hash for future drift detection.
--
--   pending_doc_imports   Staging for the multi-step /importdoc Telegram
--                         flow (disposition → deck name → mode → execute).
--
-- All timestamps are epoch milliseconds (Date.now()-shaped) to match the
-- rest of the claudeclaw-os schema.

CREATE TABLE IF NOT EXISTS anki_pending_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  deck TEXT NOT NULL,
  model TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  media_json TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  source_citation TEXT,
  content_hash TEXT,
  batch_id TEXT,
  chat_id TEXT,
  preview_message_id INTEGER,
  anki_note_id INTEGER,
  decided_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_anki_pending_status ON anki_pending_cards(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_anki_pending_batch ON anki_pending_cards(batch_id);

CREATE TABLE IF NOT EXISTS anki_card_meta (
  anki_note_id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  deck TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  source_citation TEXT,
  content_hash TEXT,
  generated_at INTEGER NOT NULL,
  last_synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_anki_card_meta_agent ON anki_card_meta(agent_id);
CREATE INDEX IF NOT EXISTS idx_anki_card_meta_source ON anki_card_meta(source_type, source_ref);

CREATE TABLE IF NOT EXISTS pending_doc_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  doc_path TEXT NOT NULL,
  detected_kind TEXT NOT NULL,
  detected_block_count INTEGER,
  proposed_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting-action',
  action TEXT,
  target_deck TEXT,
  review_mode TEXT NOT NULL DEFAULT 'auto',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_doc_imports_chat ON pending_doc_imports(chat_id, state);
