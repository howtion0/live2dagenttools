#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PROMPT_FILE="$ROOT/MCP/voice-session-prompt.md"

if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi

if [ "$#" -eq 0 ]; then
  exec claude \
    --mcp-config "$ROOT/.mcp.json" \
    --strict-mcp-config \
    --permission-mode bypassPermissions \
    "$(cat "$PROMPT_FILE")"
fi

USER_TEXT="$*"
exec claude -p \
  --mcp-config "$ROOT/.mcp.json" \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  "$(cat "$PROMPT_FILE")

User question:
$USER_TEXT"
