# ClaudeClaw Anki

Anki-backed accelerated learning for [ClaudeClaw](https://github.com/openclaw/openclaw) via Telegram. Generate Anki flashcards from text, YouTube videos, MD/HTML documents, or existing `.apkg` decks. Cards land in real Anki Desktop (with AnkiConnect), reviewed through Canvas Mini App previews, with optional auto-generated diagrams via Gemini 2.5 Flash Image ("Nano Banana").

## What it provides

### Telegram slash commands

| Command | What it does |
|---|---|
| `/card_help` | Show the full reference for every card command |
| `/cardsfromtext <deck> [topic=...] [max=N]\n<text>` | Generate cards from pasted text via Gemini |
| `/cardsfromvideo <YouTube URL> <deck> [topic=...] [max=N]` | Generate cards from a YouTube video. Gemini reads the video natively — no yt-dlp/Whisper pipeline. Cards carry timestamp citations. |
| `/importdoc <absolute-path>` | Import an MD/HTML/TXT file. Prompts for disposition (Add/New/Replace), deck name, and mode (⚡ Auto-import vs 👀 Review each). |
| `/importdeck <ankiweb-url-or-attached-.apkg>` | Install an existing `.apkg` deck — no LLM, no approval, straight in. |
| `/newcard <deck>\nfront: ...\nback: ...` | Manually create one card |
| `/editcard <id>\nfront: NEW\nback: NEW` | Edit a pending card's fields |
| `/pending` | List cards awaiting approval |
| `/previewcard <id>` | Re-send a pending card's Canvas preview |
| `/cancel` | Abort an in-flight `/importdoc` flow |

Each Canvas preview carries four inline buttons: ✅ Approve · ✏️ Edit · ❌ Reject · 🔍 Open in Canvas.

### Five card archetypes

The LLM picks the best archetype per card from a curated menu:

| Archetype | Fields | Use when |
|---|---|---|
| Basic | Front, Back, Source | Unstructured facts |
| Cloze | Text (with `{{c1::...}}`), BackExtra, Source | Fill-in-the-blank |
| Definition | Term, Definition, Example, Source | Vocabulary or named-concept recall |
| Scenario | Setup, Question, Answer, Why, Source | Decision-under-conditions (bridge auctions, medical triage, code reviews) |
| Comparison | ConceptA, ConceptB, Difference, Source | Two commonly-confused concepts |

### Nano Banana auto-diagrams

For cards where a visual aid would substantially help recall — anatomy, process flows, side-by-side comparisons — the LLM sets `needsDiagram: true` and Gemini 2.5 Flash Image generates a labeled textbook-style PNG. The diagram embeds inline in the Anki card and the Canvas preview. Conservative by default (vocabulary, single-fact cards don't get diagrams).

### MCP tools for agent-driven card creation

Two MCP tools let any Claude Code subagent drive the card pipeline:

- `anki_propose_cards_from_text(deck, sourceText, sourceLabel, ...)` — cards land in pending queue
- `anki_auto_import_text(deck, sourceText, sourceLabel, ...)` — bypass approval, commit straight to Anki

Plus the lower-level AnkiConnect verbs: `anki_health`, `anki_create_deck`, `anki_create_model`, `anki_add_note`, `anki_update_note_fields`, `anki_find_notes`, `anki_find_cards`, `anki_cards_info`, `anki_answer_cards`, `anki_store_media_file`, `anki_import_package`, `anki_sync`.

## Architecture

```
Telegram → bot.ts (slash command)
            ↓
   adapters/{text,video,document}.ts
            ↓
   prompts.ts (archetype menu + JSON shape) → Gemini → JSON cards
            ↓
   validateCardDraft + hash dedup
            ↓
   [optional] generateImagePng (Nano Banana) → media[]
            ↓
   proposePendingBatch → anki_pending_cards table
            ↓
   sendPendingPreview → Canvas PNG photo + Mini App push
            ↓
   user taps ✅ Approve
            ↓
   approvePending → AnkiConnect addNote → anki_card_meta provenance row
            ↓
   Cards live in real Anki Desktop with FSRS scheduling
```

## Prerequisites

1. **ClaudeClaw OS** running with the multi-tenant patch — this module is designed to drop into `~/claude_claw/claudeclaw-os/src/`.
2. **Anki Desktop** installed and running on the host. The launchd plist `com.claudeclaw.anki-desktop` is recommended so Anki auto-starts.
3. **AnkiConnect addon** (#2055492159) installed in Anki and reachable at `http://127.0.0.1:8765`.
4. **Gemini API key** in the tenant `.env` as `GOOGLE_API_KEY` — used for card generation AND Nano Banana image generation.
5. **ClaudeClaw Canvas** ([github.com/bostrovsky/ClaudeClaw_Canvas](https://github.com/bostrovsky/ClaudeClaw_Canvas)) installed for the rich card-preview rendering.

## Installation

### One-shot installer

```bash
cd /path/to/your/claudeclaw-os
git clone https://github.com/bostrovsky/claudeclaw_anki.git
bash claudeclaw_anki/install.sh
```

The installer:
- Copies source files into `src/`, `src/anki-adapters/`, `src/anki-models/`
- Copies test files into a `tests/anki/` subdirectory
- Applies the schema migration to each tenant's `claudeclaw.db`
- Registers the MCP server in each tenant's `settings.json`
- Builds the project
- Prints next-step instructions for the bot.ts integration (which is intentionally manual — see below)

### bot.ts integration (manual step)

The installer can't safely auto-patch `bot.ts` because there's archetype-specific wiring that depends on your bot's exact response-handling flow. After running the installer:

1. Open `src/bot.ts`
2. Add the imports from `bot-integration/imports.ts.snippet`
3. Add the command/callback handlers from `bot-integration/anki-handlers.ts.snippet` inside your `createBot()` function (or wherever you register commands)
4. Add the `setMyCommands` entries from `bot-integration/setMyCommands.ts.snippet`
5. Extend `OWN_COMMANDS` to include all the new slash commands

Then build and restart:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.<tenant>
```

## Verifying the install

1. **AnkiConnect reachable** — `curl -s http://127.0.0.1:8765 -d '{"action":"version","version":6}'` should return `{"result":6,...}`
2. **MCP registered** — confirm `anki` block in `~/.claudeclaw/<tenant>/.claude/settings.json` under `mcpServers`
3. **Schema applied** — `sqlite3 ~/.claudeclaw/<tenant>/store/claudeclaw.db ".tables"` should list `anki_pending_cards`, `anki_card_meta`, `pending_doc_imports`
4. **Slash command works** — in your Telegram chat, type `/card_help` and you should see the full reference

Or send a quick test:

```
/cardsfromtext Test::SmokeNeuron topic=neuron parts max=3
A neuron has dendrites, a cell body (soma), and an axon. Dendrites receive signals; the soma integrates them; the axon carries the action potential to axon terminals where synapses form on the next neuron's dendrites.
```

You should see 3 card previews land in chat within ~15-45 seconds, with QUESTION/ANSWER blocks visible and (depending on the LLM's call) at least one card with an inline diagram.

## License

Same as upstream ClaudeClaw.
