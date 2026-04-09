#!/usr/bin/env bash
# upstream-sync.sh — Selective upstream merge with fork-only path protection
#
# Prerequisites:
#   git remote add upstream https://github.com/anomalyco/opencode.git (if not already)
#   git config merge.ours.driver true  (registers the "keep ours" merge driver)
#
# Usage:
#   ./scripts/upstream-sync.sh [upstream-ref]
#   Default ref: upstream/dev
#
# What it does:
#   1. Fetches upstream
#   2. Registers merge.ours driver (idempotent)
#   3. Merges upstream with fork-only paths auto-resolved via .gitattributes merge=ours
#   4. If conflicts remain (in shared files), lists them for manual resolution
#   5. After resolution, runs build verification
#
# Fork-only paths (auto-protected by .gitattributes):
#   packages/opencode/src/hook/**, packages/opencode/src/memory/**,
#   packages/guardrails/**, .opencode/**, docs/ai-guardrails/**,
#   packages/opencode/src/notification/**, etc.

set -euo pipefail

UPSTREAM_REF="${1:-upstream/dev}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[sync]${NC} $*"; }
warn() { echo -e "${YELLOW}[sync]${NC} $*"; }
err()  { echo -e "${RED}[sync]${NC} $*" >&2; }

# Ensure clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Ensure upstream remote exists
if ! git remote get-url upstream &>/dev/null; then
  err "No 'upstream' remote. Run: git remote add upstream https://github.com/anomalyco/opencode.git"
  exit 1
fi

# Fetch latest upstream
log "Fetching upstream..."
git fetch upstream

# Register merge.ours driver (idempotent)
git config merge.ours.driver true

# Show what we're merging
CURRENT=$(git rev-parse --short HEAD)
TARGET=$(git rev-parse --short "$UPSTREAM_REF")
ANCESTOR=$(git merge-base HEAD "$UPSTREAM_REF" 2>/dev/null || echo "none")
AHEAD=$(git rev-list --count "$ANCESTOR".."$UPSTREAM_REF" 2>/dev/null || echo "?")

log "Current:  $CURRENT ($(git branch --show-current))"
log "Target:   $TARGET ($UPSTREAM_REF)"
log "Ancestor: ${ANCESTOR:0:7}"
log "Commits to merge: $AHEAD"

if [ "$AHEAD" = "0" ]; then
  log "Already up to date."
  exit 0
fi

# Attempt merge
log "Merging $UPSTREAM_REF..."
log "Fork-only paths will auto-resolve via .gitattributes merge=ours"

if git merge "$UPSTREAM_REF" --no-edit -m "chore: upstream sync $(git rev-parse --short "$UPSTREAM_REF") ($(date +%Y-%m-%d))"; then
  log "Merge completed cleanly!"
else
  # Conflicts detected
  warn "Merge has conflicts in shared files:"
  echo ""
  git diff --name-only --diff-filter=U | while read -r f; do
    echo "  CONFLICT: $f"
  done
  echo ""
  warn "Resolve conflicts manually, then run:"
  warn "  git add -A && git commit"
  warn "  bun turbo build && bun test"
  exit 1
fi

# Post-merge verification
log "Running build verification..."
if bun turbo build 2>&1 | tail -5; then
  log "Build succeeded!"
else
  err "Build failed after merge. Check the output above."
  exit 1
fi

log "Upstream sync complete."
log "Run 'bun dev:guardrails' to verify TUI functionality."
