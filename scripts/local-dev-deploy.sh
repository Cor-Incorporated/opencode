#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/packages/opencode"
GUARDRAILS_BIN="$ROOT/packages/guardrails/bin/opencode-guardrails"
GUARDRAILS_PROFILE="$ROOT/packages/guardrails/profile"
ALLOWED_WRITE_ROOT="$HOME/.local/bin"
ENTRYPOINT="${OPENCODE_LOCAL_ENTRYPOINT:-$ALLOWED_WRITE_ROOT/opencode}"
LIVE_WRAPPER="${OPENCODE_LOCAL_WRAPPER:-$ALLOWED_WRITE_ROOT/opencode-live-guardrails-wrapper}"
BUN_BIN="${BUN_BIN:-$(command -v bun 2>/dev/null || true)}"
if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
BUN_BIN="${BUN_BIN:-bun}"

# HIGH fix (review #205, codex): enforce write boundary. Both ENTRYPOINT and
# LIVE_WRAPPER must resolve under $HOME/.local/bin so user-supplied env vars
# cannot redirect writes to arbitrary filesystem locations.
require_under_allowed_root() {
  local label="$1"
  local path="$2"
  local parent allowed
  parent="$(cd "$(dirname "$path")" 2>/dev/null && pwd -P || true)"
  allowed="$(cd "$ALLOWED_WRITE_ROOT" 2>/dev/null && pwd -P || true)"
  if [[ -z "$parent" || -z "$allowed" || "$parent" != "$allowed" ]]; then
    echo "refusing to write $label outside $ALLOWED_WRITE_ROOT: $path" >&2
    exit 2
  fi
}

# HIGH fix (review #205, codex): only replace a path that is missing or already
# a symlink. Never clobber a regular file the user may have placed at the
# entrypoint location.
ensure_symlink_target_safe() {
  local label="$1"
  local path="$2"
  if [[ -e "$path" && ! -L "$path" ]]; then
    echo "refusing to replace existing non-symlink $label: $path" >&2
    exit 2
  fi
}

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

guardrails_profile_has_team_plugin() {
  "$BUN_BIN" --eval '
    const config = await Bun.file(process.argv[1]).json()
    const missing = ["./plugins/guardrail.ts", "./plugins/team.ts"].filter(
      (item) => !Array.isArray(config.plugin) || !config.plugin.includes(item),
    )
    if (missing.length) {
      console.error(`missing guardrails profile plugin(s): ${missing.join(", ")}`)
      process.exit(1)
    }
  ' "$GUARDRAILS_PROFILE/opencode.json" >/dev/null
}

guardrails_policy_plugins_smoke() {
  "$BUN_BIN" --conditions=browser --eval '
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")

    const profile = process.argv[1]
    const reviewMod = await import(pathToFileURL(join(profile, "plugins/guardrail-review.ts")).href)
    const gitMod = await import(pathToFileURL(join(profile, "plugins/guardrail-git.ts")).href)
    const dir = await mkdtemp(join(tmpdir(), "opencode-local-policy-check-"))
    try {
      const state = join(dir, ".opencode/guardrails/state.json")
      await mkdir(join(dir, ".opencode/guardrails"), { recursive: true })
      await Bun.write(state, JSON.stringify({ review_codex_state: "done" }))
      const events = []
      const ctx = {
        input: { client: {}, directory: dir, worktree: dir },
        mode: "enforced",
        root: join(dir, ".opencode/guardrails"),
        log: join(dir, ".opencode/guardrails/events.jsonl"),
        state,
        allow: {},
        hasCodexMcp: true,
        maxParallelTasks: 5,
        maxSessionCost: 10,
        agentModelTier: {},
        tierModels: {},
        domainDirs: {},
        mark: async (data) => {
          await Bun.write(state, JSON.stringify({ ...(await Bun.file(state).json().catch(() => ({}))), ...data }))
        },
        seen: async (type, data) => events.push({ type, ...data }),
        note: () => ({ sessionID: undefined, permission: undefined, patterns: undefined }),
        hidden: () => false,
        code: () => false,
        fact: () => false,
        stale: () => false,
        factLine: () => "",
        reviewLine: () => "",
        compact: () => "",
        deny: () => undefined,
        baseline: () => undefined,
        version: async () => undefined,
        budget: async () => 0,
        gate: () => undefined,
      }

      const review = reviewMod.createReviewPipeline(ctx)
      await review.handleExternalReviewDetection(
        { tool: "bash", args: { command: "opencode run /review" } },
        { output: "Review completed. No CRITICAL or HIGH findings were identified.", metadata: { exitCode: 0 } },
      )
      const data = await Bun.file(state).json()
      if (data.review_glm_state !== "done" || data.review_state !== "done") {
        console.error("guardrail-review did not mark external review complete")
        process.exit(1)
      }

      const git = gitMod.createGitHandlers(ctx, review)
      await Bun.$`git init`.cwd(dir).quiet()
      await Bun.$`git config core.fsmonitor false`.cwd(dir).quiet()
      await Bun.$`git config commit.gpgsign false`.cwd(dir).quiet()
      await Bun.$`git config user.email "local-check@opencode.test"`.cwd(dir).quiet()
      await Bun.$`git config user.name "OpenCode Local Check"`.cwd(dir).quiet()
      await Bun.$`git commit --allow-empty -m root`.cwd(dir).quiet()
      await Bun.$`git branch -M dev`.cwd(dir).quiet()
      await Bun.$`git update-ref refs/remotes/origin/dev HEAD`.cwd(dir).quiet()
      await Bun.$`git checkout -b docs-smoke`.cwd(dir).quiet()
      await mkdir(join(dir, "docs"), { recursive: true })
      await Bun.write(join(dir, "docs/guardrails.md"), "docs-only local deploy smoke\n")
      await Bun.$`git add docs/guardrails.md`.cwd(dir).quiet()
      await Bun.$`git commit -m "docs: local deploy smoke"`.cwd(dir).quiet()
      try {
        await git.bashBeforeGit("git merge dev", {}, {})
      } catch (err) {
        console.error(`guardrail-git docs-only merge smoke should pass: ${String(err)}`)
        process.exit(1)
      }

      await Bun.$`git checkout -B policy-smoke origin/dev`.cwd(dir).quiet()
      await mkdir(join(dir, "packages/guardrails/profile/plugins"), { recursive: true })
      await Bun.write(join(dir, "packages/guardrails/profile/plugins/guardrail-git.ts"), "policy local deploy smoke\n")
      await Bun.$`git add packages/guardrails/profile/plugins/guardrail-git.ts`.cwd(dir).quiet()
      await Bun.$`git commit -m "fix: local deploy policy smoke"`.cwd(dir).quiet()
      try {
        await git.bashBeforeGit("git merge dev", {}, {})
        console.error("guardrail-git source/policy merge smoke should block FULL tier")
        process.exit(1)
      } catch (err) {
        if (!String(err).includes("merge blocked (FULL tier)")) {
          console.error(`guardrail-git source/policy merge smoke blocked for wrong reason: ${String(err)}`)
          process.exit(1)
        }
      }

      const blocked = []
      for (const cmd of [
        "git push origin main",
        "git reset --soft origin/dev",
        "codex exec '\''review PR #1'\''",
      ]) {
        try {
          await git.bashBeforeGit(cmd, {}, {})
        } catch (err) {
          if (String(err).includes("Guardrail policy blocked")) blocked.push(cmd)
        }
      }
      if (blocked.length !== 3) {
        console.error(`guardrail-git policy smoke blocked ${blocked.length}/3 commands`)
        process.exit(1)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  ' "$GUARDRAILS_PROFILE" >/dev/null
}

guardrails_team_plugin_loads() {
  "$BUN_BIN" --conditions=browser --eval '
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join, resolve } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const config = await Bun.file(process.argv[1]).json()
    const entry = Array.isArray(config.plugin) ? config.plugin.find((item) => item === "./plugins/team.ts") : undefined
    if (!entry) {
      console.error("missing ./plugins/team.ts in guardrails profile plugin list")
      process.exit(1)
    }
    const dir = await mkdtemp(join(tmpdir(), "opencode-local-check-"))
    try {
      const mod = await import(pathToFileURL(resolve(process.argv[2], entry)).href)
      const plugin = await mod.default({ client: {}, worktree: dir, directory: dir })
      const missing = ["team", "background", "team_status"].filter(
        (name) => typeof plugin?.tool?.[name]?.execute !== "function",
      )
      if (missing.length) {
        console.error(`missing guardrails team tools: ${missing.join(", ")}`)
        process.exit(1)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  ' "$GUARDRAILS_PROFILE/opencode.json" "$GUARDRAILS_PROFILE" >/dev/null
}

repair_links() {
  mkdir -p "$ALLOWED_WRITE_ROOT" "$PACKAGE/bin"

  # HIGH fix (review #205, codex): boundary-check both write targets after
  # ALLOWED_WRITE_ROOT exists so pwd -P can resolve it.
  require_under_allowed_root "ENTRYPOINT" "$ENTRYPOINT"
  require_under_allowed_root "LIVE_WRAPPER" "$LIVE_WRAPPER"

  # HIGH fix (review #205, codex): shell-escape paths in the heredoc so that
  # spaces or metacharacters in repo path / GUARDRAILS_BIN cannot break the
  # generated wrapper or inject shell.
  local active_q guard_q
  active_q=$(printf '%q' "$ACTIVE_BINARY")
  guard_q=$(printf '%q' "$GUARDRAILS_BIN")
  cat > "$LIVE_WRAPPER" <<EOF
#!/bin/zsh
export OPENCODE_BIN_PATH=$active_q
exec $guard_q "\$@"
EOF
  chmod 755 "$LIVE_WRAPPER"

  # HIGH fix (review #205, codex): refuse to overwrite a regular file at
  # ENTRYPOINT or CACHED_BUNDLE; only replace symlinks or missing paths.
  ensure_symlink_target_safe "ENTRYPOINT" "$ENTRYPOINT"
  ensure_symlink_target_safe "CACHED_BUNDLE" "$CACHED_BUNDLE"

  ln -sfn "$LIVE_WRAPPER" "$ENTRYPOINT"
  ln -sfn "$CACHED_TARGET" "$CACHED_BUNDLE"
}

if [[ "$mode" == "deploy" ]]; then
  (cd "$PACKAGE" && "$BUN_BIN" run build)
  repair_links
elif [[ "$mode" == "fix" ]]; then
  repair_links
fi

mark "$([[ -x "$GUARDRAILS_BIN" ]] && echo ok || echo fail)" "guardrails wrapper is executable"
mark "$(grep -Fq "OPENCODE_CONFIG_DIR" "$GUARDRAILS_BIN" 2>/dev/null && echo ok || echo fail)" "guardrails wrapper sets OPENCODE_CONFIG_DIR"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/auto.md" ]] && echo ok || echo fail)" "guardrails profile includes /auto"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/plan.md" ]] && echo ok || echo fail)" "guardrails profile includes /plan"
mark "$(guardrails_profile_has_team_plugin && echo ok || echo fail)" "guardrails profile enables guardrail and team plugins"
mark "$(guardrails_policy_plugins_smoke && echo ok || echo fail)" "guardrails review/git policy smoke passes"
mark "$(guardrails_team_plugin_loads && echo ok || echo fail)" "guardrails team plugin loads team/background/team_status"

entry_target="$(readlink "$ENTRYPOINT" 2>/dev/null || true)"
mark "$([[ "$entry_target" == "$LIVE_WRAPPER" ]] && echo ok || echo fail)" "entrypoint is fixed: $ENTRYPOINT -> $LIVE_WRAPPER"

cached_target="$(readlink "$CACHED_BUNDLE" 2>/dev/null || true)"
mark "$([[ "$cached_target" == "$CACHED_TARGET" ]] && echo ok || echo fail)" "cached bundle is fixed: $CACHED_BUNDLE -> $CACHED_TARGET"

mark "$([[ -x "$ACTIVE_BINARY" ]] && echo ok || echo fail)" "active binary is executable: $ACTIVE_BINARY"
# After heredoc escaping, the wrapper now contains the shell-quoted form of
# ACTIVE_BINARY (e.g. paths with spaces become quoted), so check both forms:
# the raw assignment and the printf %q form.
active_q_check=$(printf '%q' "$ACTIVE_BINARY")
guard_q_check=$(printf '%q' "$GUARDRAILS_BIN")
mark "$(grep -Fq "OPENCODE_BIN_PATH=$active_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper pins active binary"
mark "$(grep -Fq "exec $guard_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper enters guardrails profile"

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
