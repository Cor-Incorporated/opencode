#!/usr/bin/env bash
# link-guardrails.sh — Symlink guardrails profile commands/agents to .opencode/
# Runs automatically via postinstall to ensure desktop app sees all commands.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/packages/guardrails/profile"
CONFIG="$ROOT/.opencode"

if [ ! -d "$PROFILE/commands" ]; then
  echo "[link-guardrails] Profile not found at $PROFILE, skipping"
  exit 0
fi

mkdir -p "$CONFIG/command" "$CONFIG/agent"

linked=0
for cmd in "$PROFILE/commands"/*.md; do
  name=$(basename "$cmd")
  target="$CONFIG/command/$name"
  if [ ! -e "$target" ]; then
    ln -s "../../packages/guardrails/profile/commands/$name" "$target"
    linked=$((linked + 1))
  fi
done

for agent in "$PROFILE/agents"/*.md; do
  name=$(basename "$agent")
  target="$CONFIG/agent/$name"
  if [ ! -e "$target" ]; then
    ln -s "../../packages/guardrails/profile/agents/$name" "$target"
    linked=$((linked + 1))
  fi
done

if [ "$linked" -gt 0 ]; then
  echo "[link-guardrails] Created $linked symlinks"
else
  echo "[link-guardrails] All symlinks up to date"
fi
