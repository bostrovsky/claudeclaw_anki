#!/bin/bash
# scripts/smoke.sh — End-to-end install verifier for ClaudeClaw Anki.
#
# Exercises each layer without sending a Telegram message:
#   1. AnkiConnect reachable (Anki Desktop running + addon installed)
#   2. Schema migration applied to the tenant DB
#   3. Gemini text-gen works (returns valid card JSON)
#   4. Card validation + dedup passes
#   5. Canvas preview HTML renders to a PNG via Playwright
#   6. AnkiConnect addNote+deleteNotes works (does not pollute your collection)
#   7. Cleanup: removes the smoke-test pending rows from the DB
#
# Usage (from your claudeclaw-os root):
#   bash claudeclaw_anki/scripts/smoke.sh [tenant]
#
# If no tenant arg is given, picks the first tenant under ~/.claudeclaw/*
# that has GOOGLE_API_KEY set.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Resolve claudeclaw-os root: prefer $CLAW_ROOT env override, else
# REPO_DIR/.. (this repo sitting alongside src/), else cwd.
CLAW_ROOT="${CLAW_ROOT:-}"
if [ -z "$CLAW_ROOT" ]; then
  if [ -f "$REPO_DIR/../src/bot.ts" ]; then
    CLAW_ROOT="$(cd "$REPO_DIR/.." && pwd)"
  elif [ -f "$(pwd)/src/bot.ts" ]; then
    CLAW_ROOT="$(pwd)"
  else
    echo "✗ Could not locate claudeclaw-os root. Run this from your claudeclaw-os directory, or set CLAW_ROOT=/path/to/claudeclaw-os."
    exit 1
  fi
fi

# ── Pick tenant ──────────────────────────────────────────────────────
TENANT="${1:-}"
if [ -z "$TENANT" ]; then
  for dir in ~/.claudeclaw/*/; do
    [ -d "$dir" ] || continue
    if [ -f "$dir/.env" ] && grep -q "^GOOGLE_API_KEY=" "$dir/.env"; then
      TENANT=$(basename "${dir%/}")
      break
    fi
  done
fi
if [ -z "$TENANT" ]; then
  echo "✗ No tenant under ~/.claudeclaw/* has GOOGLE_API_KEY in its .env."
  echo "  Add a key to at least one tenant's .env, then re-run."
  exit 1
fi
TENANT_DIR="$HOME/.claudeclaw/$TENANT"
if [ ! -f "$TENANT_DIR/.env" ]; then
  echo "✗ Tenant '$TENANT' has no .env at $TENANT_DIR/.env"
  exit 1
fi
echo "Using tenant: $TENANT"
echo "Claudeclaw-os root: $CLAW_ROOT"
echo ""

# ── Extract env values needed by the node script ─────────────────────
GOOGLE_API_KEY=$(grep '^GOOGLE_API_KEY=' "$TENANT_DIR/.env" | cut -d= -f2- | tr -d '"' | head -1)
DB_ENCRYPTION_KEY=$(grep '^DB_ENCRYPTION_KEY=' "$TENANT_DIR/.env" | cut -d= -f2- | tr -d '"' | head -1)
ANKI_PROFILE=$(grep '^ANKI_PROFILE=' "$TENANT_DIR/.env" | cut -d= -f2- | tr -d '"' | head -1)
ANKI_CONNECT_URL=$(grep '^ANKI_CONNECT_URL=' "$TENANT_DIR/.env" | cut -d= -f2- | tr -d '"' | head -1)
[ -z "$ANKI_CONNECT_URL" ] && ANKI_CONNECT_URL="http://127.0.0.1:8765"

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "✗ GOOGLE_API_KEY is empty in $TENANT_DIR/.env"
  exit 1
fi

# ── Verify build output exists ───────────────────────────────────────
if [ ! -f "$CLAW_ROOT/dist/anki-adapters/text.js" ]; then
  echo "✗ Build artifacts not found at $CLAW_ROOT/dist/anki-adapters/text.js"
  echo "  Run \`npm run build\` from $CLAW_ROOT first."
  exit 1
fi

# ── Hand off to the node script ──────────────────────────────────────
GOOGLE_API_KEY="$GOOGLE_API_KEY" \
DB_ENCRYPTION_KEY="$DB_ENCRYPTION_KEY" \
ANKI_PROFILE="$ANKI_PROFILE" \
ANKI_CONNECT_URL="$ANKI_CONNECT_URL" \
CLAUDECLAW_DATA_DIR="$TENANT_DIR" \
CLAUDECLAW_AGENT_ID="main" \
CLAW_ROOT="$CLAW_ROOT" \
SMOKE_TENANT="$TENANT" \
  node "$SCRIPT_DIR/smoke.mjs"
