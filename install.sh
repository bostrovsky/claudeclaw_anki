#!/bin/bash
# ClaudeClaw Anki — installer
#
# Run from your claudeclaw-os root directory:
#   git clone https://github.com/bostrovsky/claudeclaw_anki.git
#   bash claudeclaw_anki/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAW_DIR="$(pwd)"

# ── Verify we're in a ClaudeClaw directory ────────────────────────────
if [ ! -f "$CLAW_DIR/src/bot.ts" ] || [ ! -f "$CLAW_DIR/src/index.ts" ]; then
  echo "Error: Run this from your ClaudeClaw OS root directory."
  echo "  cd /path/to/claudeclaw-os && bash $0"
  exit 1
fi

# ── Verify prerequisites ──────────────────────────────────────────────
echo "Checking prerequisites…"

# Canvas must be installed
if [ ! -f "$CLAW_DIR/src/canvas-render.ts" ]; then
  echo "  ✗ ClaudeClaw Canvas is not installed. Install it first:"
  echo "      git clone https://github.com/bostrovsky/ClaudeClaw_Canvas.git"
  echo "      bash ClaudeClaw_Canvas/install.sh"
  exit 1
fi
echo "  ✓ Canvas installed"

# AnkiConnect reachable
if ! curl -sf -m 3 http://127.0.0.1:8765 -H 'Content-Type: application/json' -d '{"action":"version","version":6}' > /dev/null 2>&1; then
  echo "  ⚠ AnkiConnect not reachable at http://127.0.0.1:8765"
  echo "    Make sure Anki Desktop is running with the AnkiConnect addon (#2055492159)."
  echo "    Continuing anyway — you can fix this later, but cards won't actually commit until it's up."
else
  echo "  ✓ AnkiConnect reachable"
fi

# At least one tenant has GOOGLE_API_KEY
if ! grep -l "^GOOGLE_API_KEY=" ~/.claudeclaw/*/.env >/dev/null 2>&1; then
  echo "  ⚠ No tenant .env has GOOGLE_API_KEY set."
  echo "    Card generation will fail until you add one. Add to each tenant's .env:"
  echo "      GOOGLE_API_KEY=<your-key>"
else
  echo "  ✓ GOOGLE_API_KEY configured for at least one tenant"
fi

echo ""
echo "Installing ClaudeClaw Anki into $CLAW_DIR"

# ── Copy source files ────────────────────────────────────────────────
echo "  Copying source files…"
mkdir -p "$CLAW_DIR/src/anki-adapters" "$CLAW_DIR/src/anki-models"
for f in anki-mcp.ts anki-mcp-core.ts anki-pending.ts gemini-image.ts; do
  cp "$SCRIPT_DIR/src/$f" "$CLAW_DIR/src/$f"
done
for f in prompts.ts text.ts video.ts document.ts doc-import.ts dave-bidding-system.ts import-apkg.ts; do
  cp "$SCRIPT_DIR/src/anki-adapters/$f" "$CLAW_DIR/src/anki-adapters/$f"
done
for f in basic-rich.json cloze-rich.json definition.json scenario.json comparison.json; do
  cp "$SCRIPT_DIR/src/anki-models/$f" "$CLAW_DIR/src/anki-models/$f"
done
echo "    ✓ 4 top-level + 7 adapter + 5 model JSON files copied"

# ── Copy tests (under tests/anki/ so they don't collide with claudeclaw-os own tests) ──
echo "  Copying tests…"
mkdir -p "$CLAW_DIR/tests/anki"
cp "$SCRIPT_DIR/tests/"*.ts "$CLAW_DIR/tests/anki/" 2>/dev/null || true
echo "    ✓ $(ls "$CLAW_DIR/tests/anki/" | wc -l | tr -d ' ') test files copied"

# ── Apply schema migration to each tenant DB ─────────────────────────
echo "  Applying schema migration to tenant databases…"
SCHEMA="$SCRIPT_DIR/migrations/schema.sql"
applied=0
for db in ~/.claudeclaw/*/store/claudeclaw.db; do
  [ -f "$db" ] || continue
  tenant=$(basename "$(dirname "$(dirname "$db")")")
  sqlite3 "$db" < "$SCHEMA"
  echo "    ✓ $tenant"
  applied=$((applied+1))
done
if [ "$applied" -eq 0 ]; then
  echo "    ⚠ No tenant databases found under ~/.claudeclaw/*/store/claudeclaw.db"
  echo "      Run the schema manually after your tenants are set up:"
  echo "        sqlite3 <db-path> < $SCHEMA"
fi

# ── Register MCP server in each tenant's settings.json ───────────────
echo "  Registering Anki MCP in tenant settings.json…"
for st in ~/.claudeclaw/*/.claude/settings.json; do
  [ -f "$st" ] || continue
  tenant=$(basename "$(dirname "$(dirname "$st")")")
  if grep -q '"anki"' "$st"; then
    echo "    - $tenant: already registered, skipping"
    continue
  fi
  # Use jq to merge in the anki MCP block
  if command -v jq >/dev/null 2>&1; then
    tmp=$(mktemp)
    jq --arg dataDir "$HOME/.claudeclaw/$tenant" --arg dist "$CLAW_DIR/dist/anki-mcp.js" '.mcpServers.anki = {command: "node", args: [$dist], env: {CLAUDECLAW_DATA_DIR: $dataDir, CLAUDECLAW_AGENT_ID: "main"}}' "$st" > "$tmp" && mv "$tmp" "$st"
    echo "    ✓ $tenant: anki MCP added"
  else
    echo "    ⚠ $tenant: jq not installed, can't auto-edit settings.json"
    echo "      Add this block manually to $st under mcpServers:"
    echo '      "anki": {'
    echo '        "command": "node",'
    echo "        \"args\": [\"$CLAW_DIR/dist/anki-mcp.js\"],"
    echo '        "env": {'
    echo "          \"CLAUDECLAW_DATA_DIR\": \"$HOME/.claudeclaw/$tenant\","
    echo '          "CLAUDECLAW_AGENT_ID": "main"'
    echo '        }'
    echo '      }'
  fi
done

# ── Build ────────────────────────────────────────────────────────────
echo "  Building (this also copies anki-models/*.json into dist/)…"
npm run build 2>&1 | tail -3

echo ""
echo "============================================"
echo "  ClaudeClaw Anki installed!"
echo "============================================"
echo ""
echo "Manual step required — wire the bot.ts integration:"
echo ""
echo "  1. Open src/bot.ts"
echo "  2. Add imports from:    $SCRIPT_DIR/bot-integration/imports.ts.snippet"
echo "  3. Add handlers from:   $SCRIPT_DIR/bot-integration/anki-handlers.ts.snippet"
echo "  4. Add command entries: $SCRIPT_DIR/bot-integration/setMyCommands.ts.snippet"
echo "  5. Extend OWN_COMMANDS to include the new slash commands"
echo ""
echo "Then rebuild and restart your tenants:"
echo "  npm run build"
echo "  for tenant in brian jodie christine; do"
echo "    launchctl kickstart -k gui/\$(id -u)/com.claudeclaw.\$tenant 2>/dev/null || true"
echo "  done"
echo ""
echo "Send /card_help in Telegram to see the full reference."
