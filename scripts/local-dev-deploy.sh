#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/packages/opencode"
GUARDRAILS_BIN="$ROOT/packages/guardrails/bin/opencode-guardrails"
GUARDRAILS_PROFILE="$ROOT/packages/guardrails/profile"
ENTRYPOINT="${OPENCODE_LOCAL_ENTRYPOINT:-$HOME/.local/bin/opencode}"
LIVE_WRAPPER="${OPENCODE_LOCAL_WRAPPER:-$HOME/.local/bin/opencode-live-guardrails-wrapper}"

platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$platform" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *) echo "unsupported platform: $platform" >&2; exit 2 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 2 ;;
esac

ACTIVE_BINARY="$PACKAGE/dist/opencode-$platform-$arch/bin/opencode"
CACHED_BUNDLE="$PACKAGE/bin/.opencode"
CACHED_TARGET="../dist/opencode-$platform-$arch/bin/opencode"

usage() {
  cat <<'EOF'
Usage:
  bun run local:deploy
  bun run local:check
  bun run local:fix
  bash scripts/local-dev-deploy.sh [--check|--fix|--no-build]

Deploy the local opencode development build into the fixed local runtime path.

Default:
  1. build packages/opencode
  2. point packages/opencode/bin/.opencode at the new dist binary
  3. point ~/.local/bin/opencode at the guardrails live wrapper
  4. verify /auto and /plan are available from the guardrails profile

Modes:
  --check     validate only
  --fix       repair wrappers and symlinks without rebuilding
  --no-build  alias for --fix
EOF
}

mode="deploy"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --fix|--no-build) mode="fix" ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac

failures=0
mark() {
  local ok="$1"
  local message="$2"
  if [[ "$ok" == "ok" ]]; then
    printf 'ok   %s\n' "$message"
  else
    printf 'FAIL %s\n' "$message"
    failures=$((failures + 1))
  fi
}

repair_links() {
  mkdir -p "$HOME/.local/bin" "$PACKAGE/bin"

  cat > "$LIVE_WRAPPER" <<EOF
#!/bin/zsh
export OPENCODE_BIN_PATH=$ACTIVE_BINARY
exec $GUARDRAILS_BIN "\$@"
EOF
  chmod 755 "$LIVE_WRAPPER"

  ln -sfn "$LIVE_WRAPPER" "$ENTRYPOINT"
  ln -sfn "$CACHED_TARGET" "$CACHED_BUNDLE"
}

if [[ "$mode" == "deploy" ]]; then
  (cd "$PACKAGE" && bun run build)
  repair_links
elif [[ "$mode" == "fix" ]]; then
  repair_links
fi

mark "$([[ -x "$GUARDRAILS_BIN" ]] && echo ok || echo fail)" "guardrails wrapper is executable"
mark "$(grep -Fq "OPENCODE_CONFIG_DIR" "$GUARDRAILS_BIN" 2>/dev/null && echo ok || echo fail)" "guardrails wrapper sets OPENCODE_CONFIG_DIR"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/auto.md" ]] && echo ok || echo fail)" "guardrails profile includes /auto"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/plan.md" ]] && echo ok || echo fail)" "guardrails profile includes /plan"

entry_target="$(readlink "$ENTRYPOINT" 2>/dev/null || true)"
mark "$([[ "$entry_target" == "$LIVE_WRAPPER" ]] && echo ok || echo fail)" "entrypoint is fixed: $ENTRYPOINT -> $LIVE_WRAPPER"

cached_target="$(readlink "$CACHED_BUNDLE" 2>/dev/null || true)"
mark "$([[ "$cached_target" == "$CACHED_TARGET" ]] && echo ok || echo fail)" "cached bundle is fixed: $CACHED_BUNDLE -> $CACHED_TARGET"

mark "$([[ -x "$ACTIVE_BINARY" ]] && echo ok || echo fail)" "active binary is executable: $ACTIVE_BINARY"
mark "$(grep -Fq "OPENCODE_BIN_PATH=$ACTIVE_BINARY" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper pins active binary"
mark "$(grep -Fq "exec $GUARDRAILS_BIN" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper enters guardrails profile"

entry_version="$("$ENTRYPOINT" --version 2>/dev/null || true)"
active_version="$("$ACTIVE_BINARY" --version 2>/dev/null || true)"
mark "$([[ -n "$entry_version" && "$entry_version" == "$active_version" ]] && echo ok || echo fail)" "entrypoint version matches active binary: ${entry_version:-missing}"

if [[ "$failures" -gt 0 ]]; then
  printf '\n%s check(s) failed.\n' "$failures"
  if [[ "$mode" == "check" ]]; then
    printf 'Run: bun run local:fix\n'
  fi
  exit 1
fi

printf '\nlocal opencode deploy target is fixed.\n'
