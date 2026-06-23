---
name: install-anki
description: Install ClaudeClaw Anki - Anki-backed accelerated learning via Telegram. Generates flashcards from text, YouTube videos, MD/HTML docs, or .apkg decks. Cards land in real Anki Desktop via AnkiConnect, reviewed through Canvas Mini App previews, with optional auto-generated diagrams via Gemini Nano Banana.
argument-hint: ""
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
user-invocable: true
---

# Install ClaudeClaw Anki

You are installing the ClaudeClaw Anki module from https://github.com/bostrovsky/claudeclaw_anki.git

## What this does

Adds Telegram-driven Anki card generation to ClaudeClaw:
- Six slash commands (`/cardsfromtext`, `/cardsfromvideo`, `/importdoc`, `/importdeck`, `/newcard`, `/card_help` and three management commands)
- Five card archetypes (Basic, Cloze, Definition, Scenario, Comparison) — the LLM picks per card
- Optional auto-generated diagrams via Gemini 2.5 Flash Image ("Nano Banana") for spatial/structural content
- A pending-card approval queue with Canvas Mini App previews
- An MCP server exposing AnkiConnect verbs + agent-driven card creation tools
- A provenance ledger so source-sync logic can detect drift between regenerations

## Prerequisites

Verify these BEFORE running the installer:

1. **Anki Desktop** is installed and running on the host. Confirm with:
   ```bash
   pgrep -lf "Anki.app" || echo "Anki Desktop not running"
   ```
   If not running, ask the user to launch it (recommend setting up `com.claudeclaw.anki-desktop` launchd plist to keep it alive).

2. **AnkiConnect addon (#2055492159)** is installed and reachable:
   ```bash
   curl -s http://127.0.0.1:8765 -d '{"action":"version","version":6}' | jq .result
   ```
   Should return `6` (the AnkiConnect API version). If not, instruct the user:
   - Open Anki → Tools → Add-ons → Get Add-ons → paste `2055492159` → Restart Anki.

3. **GOOGLE_API_KEY** is set in each tenant's `.env`:
   ```bash
   grep -l "^GOOGLE_API_KEY=" ~/.claudeclaw/*/.env || echo "No tenant has GOOGLE_API_KEY"
   ```
   If missing, ask the user for the key.

4. **ClaudeClaw Canvas** is already installed (needed for card-preview rendering):
   ```bash
   test -f "$(git rev-parse --show-toplevel)/src/canvas-render.ts" && echo "OK" || echo "MISSING — install Canvas first"
   ```
   If missing, tell the user to install [ClaudeClaw Canvas](https://github.com/bostrovsky/ClaudeClaw_Canvas) first.

## Installation steps

### Step 1: Find the ClaudeClaw root

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
```

If that fails (not in a git repo), ask the user where their `claudeclaw-os` directory is.

### Step 2: Clone and run the installer

```bash
cd "$PROJECT_ROOT"
if [ ! -d claudeclaw_anki ]; then
  git clone https://github.com/bostrovsky/claudeclaw_anki.git
fi
bash claudeclaw_anki/install.sh
```

The installer copies source files, applies the schema migration to each tenant's claudeclaw.db, registers the MCP server in each tenant's settings.json, and builds the project.

### Step 3: Manual bot.ts integration

After the installer runs, three small edits are required in `src/bot.ts`. Open the snippet files in `claudeclaw_anki/bot-integration/`:

- `imports.ts.snippet` — module imports (add near the top of bot.ts, with other adapter imports)
- `anki-handlers.ts.snippet` — all the command + callback handlers (paste inside `createBot()` or your equivalent, ideally right before `bot.on('message:text', ...)`)
- `setMyCommands.ts.snippet` — Telegram command-autocomplete entries (add to your `builtInCommands` array)

Also extend the `OWN_COMMANDS` set so the text handler doesn't try to send these to Claude:

```typescript
const OWN_COMMANDS = new Set([
  ...existing,
  '/newcard', '/editcard', '/pending', '/previewcard',
  '/cardsfromtext', '/cardsfromvideo', '/importdeck', '/importdoc',
  '/cancel', '/card_help'
]);
```

### Step 4: Build and restart

```bash
cd "$PROJECT_ROOT"
npm run build
for tenant in brian jodie christine; do
  launchctl kickstart -k gui/$(id -u)/com.claudeclaw.$tenant 2>/dev/null || true
done
```

### Step 5: Verify

```bash
# AnkiConnect reachable from the tenant
curl -s http://127.0.0.1:8765 -d '{"action":"version","version":6}' | jq .result
# Should print: 6

# Schema applied to each tenant
for db in ~/.claudeclaw/*/store/claudeclaw.db; do
  echo "$db:"
  sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'anki_%' OR name='pending_doc_imports'"
done
# Should list: anki_pending_cards, anki_card_meta, pending_doc_imports

# Bot has the commands registered with Telegram
curl -s "https://api.telegram.org/bot$(grep TELEGRAM_BOT_TOKEN ~/.claudeclaw/<tenant>/.env | cut -d= -f2)/getMyCommands" | jq -r '.result[] | select(.command | test("card|import")) | .command'
# Should list all the new commands
```

Tell the user to send `/card_help` in their Telegram chat to see the full reference. Then send a test:

```
/cardsfromtext Test::SmokeNeuron topic=neuron parts max=3
A neuron has dendrites, a cell body (soma), and an axon. Dendrites receive signals; the soma integrates them; the axon carries the action potential to axon terminals where synapses form on the next neuron's dendrites.
```

Within 15-45 seconds, 3 cards should arrive as Canvas-rendered photos with QUESTION/ANSWER blocks and Approve/Edit/Reject buttons.

## Troubleshooting

- **`/cardsfromtext` doesn't fire** — Check OWN_COMMANDS in bot.ts includes the new commands. Verify the handler block was inserted inside the function that registers bot commands.
- **Bot says "GOOGLE_API_KEY is not set"** — The tenant's `.env` is missing the key. Add it and restart.
- **AnkiConnect error "Is Anki Desktop running?"** — Anki Desktop crashed or isn't running. Restart it.
- **No diagram on visual-content cards** — The LLM may be too conservative. Cards with `needsDiagram: true` in the LLM response trigger Nano Banana; check the bot logs (`/tmp/claudeclaw-<tenant>.log`) for `gemini-image` entries.
- **Cards appear in pending but `/pending` is empty** — Per-agent queue. Cards land under the `agent_id` from `CLAUDECLAW_AGENT_ID` env (set in the MCP block of settings.json). Check the value matches the bot's agent.
- **Canvas preview empty or "Waiting for content..."** — The Canvas Mini App couldn't fetch assets through the Funnel. Confirm `<base href="/canvas/">` is in `web/public/canvas/index.html` (from the Canvas install).
