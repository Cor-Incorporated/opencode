#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/packages/opencode"
GUARDRAILS_BIN="$ROOT/packages/guardrails/bin/opencode-guardrails"
GUARDRAILS_PROFILE="$ROOT/packages/guardrails/profile"
ALLOWED_WRITE_ROOT="$HOME/.local/bin"
ENTRYPOINT="${OPENCODE_LOCAL_ENTRYPOINT:-$ALLOWED_WRITE_ROOT/opencode}"
LIVE_WRAPPER="${OPENCODE_LOCAL_WRAPPER:-$ALLOWED_WRITE_ROOT/opencode-live-guardrails-wrapper}"
LOCAL_DB="${OPENCODE_LOCAL_DB:-opencode-local.db}"
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
ZAI_CODING_PLAN_PROVIDER="zai-coding-plan"
ZAI_CODING_PLAN_MODEL="glm-5.2"
ZAI_CODING_PLAN_MODEL_REF="$ZAI_CODING_PLAN_PROVIDER/$ZAI_CODING_PLAN_MODEL"
ZAI_CODING_PLAN_STALE_DEFAULT="$ZAI_CODING_PLAN_PROVIDER/glm-5.1"
MANAGED_PROFILE="$ROOT/packages/guardrails/managed/opencode.json"

usage() {
  cat <<'EOF'
Usage:
  bun run local:deploy
  bun run local:check
  bun run local:fix
  bash scripts/local-dev-deploy.sh [--check|--fix|--no-build|--check-zai-coding-plan|--check-openrouter-catalog]

Deploy the local opencode development build into the fixed local runtime path.
The wrapper defaults OPENCODE_DB to opencode-local.db unless the caller
explicitly provides OPENCODE_DB.

Default:
  1. build packages/opencode
  2. point packages/opencode/bin/.opencode at the new dist binary
  3. point ~/.local/bin/opencode at the guardrails live wrapper
  4. default local runtime DB to opencode-local.db
  5. verify /auto and /plan are available from the guardrails profile

Modes:
  --check     validate only
  --fix       repair wrappers and symlinks without rebuilding
  --no-build  alias for --fix
  --check-zai-coding-plan
              validate only the local Z.AI Coding Plan catalog/default scenario
  --check-openrouter-catalog
              validate OpenRouter whitelist freshness against live official catalogs
EOF
}

mode="deploy"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --fix|--no-build) mode="fix" ;;
  --check-zai-coding-plan) mode="check-zai-coding-plan" ;;
  --check-openrouter-catalog) mode="check-openrouter-catalog" ;;
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

      try {
        await git.bashBeforeGit(
          "gh issue close 123 --comment '\''操作テストはブラウザで確認済のためクローズします'\''",
          {},
          {},
        )
        console.error("guardrail-git UAT issue close smoke should block missing evidence")
        process.exit(1)
      } catch (err) {
        if (!String(err).includes("UAT/UX/E2E/browser-tested issue or PR completion requires browser/live evidence markers")) {
          console.error(`guardrail-git UAT issue close smoke blocked for wrong reason: ${String(err)}`)
          process.exit(1)
        }
      }

      const uatState = await Bun.file(state).json()
      if (uatState.last_reason !== "UAT/browser evidence missing") {
        console.error(`guardrail-git UAT issue close smoke recorded wrong state: ${JSON.stringify(uatState)}`)
        process.exit(1)
      }

      try {
        await git.bashBeforeGit(
          "gh issue close 123 --comment '\''操作テストはブラウザで確認済です。Browser evidence: docs/v2/live-evidence/uat-2026-06-23/playwright-report.zip Timestamp: 2026-06-23T09:00:00Z Visible UI signal: tenant dashboard Auth class: app user Screenshot hash: sha256:0123456789abcdef'\''",
          {},
          {},
        )
      } catch (err) {
        console.error(`guardrail-git UAT issue close smoke should allow complete evidence: ${String(err)}`)
        process.exit(1)
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

guardrails_team_fallback_smoke() {
  "$BUN_BIN" --conditions=browser --eval '
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")

    const dir = await mkdtemp(join(tmpdir(), "opencode-local-team-fallback-"))
    try {
      await Bun.write(join(dir, "README.md"), "# local team fallback smoke\n")
      await Bun.$`git init`.cwd(dir).quiet()
      await Bun.$`git config core.fsmonitor false`.cwd(dir).quiet()
      await Bun.$`git config commit.gpgsign false`.cwd(dir).quiet()
      await Bun.$`git config user.email "local-check@opencode.test"`.cwd(dir).quiet()
      await Bun.$`git config user.name "OpenCode Local Check"`.cwd(dir).quiet()
      await Bun.$`git add README.md`.cwd(dir).quiet()
      await Bun.$`git commit -m seed`.cwd(dir).quiet()

      const mod = await import(pathToFileURL(join(process.argv[1], "plugins/team.ts")).href)
      let model
      const plugin = await mod.default({
        client: {
          permission: { list: async () => ({ data: [] }) },
          question: { list: async () => ({ data: [] }) },
          session: {
            get: async () => ({ data: { permission: [] } }),
            create: async () => ({ data: { id: "ses_child_fallback_model" } }),
            promptAsync: async (input) => {
              model = input.body.model
              return {}
            },
            prompt: async () => ({}),
            status: async () => ({ data: { ses_child_fallback_model: { type: "idle" } } }),
            messages: async () => ({
              data: [
                {
                  info: { role: "assistant", time: { completed: Date.now() } },
                  parts: [{ type: "text", text: "done" }],
                },
              ],
            }),
            abort: async () => ({}),
          },
        },
        worktree: dir,
        directory: dir,
      })

      const output = await plugin.tool.team.execute(
        {
          tasks: [
            {
              id: "fallback-model",
              prompt: "Inspect the local runtime fallback model without a recorded parent model.",
              write: false,
              worktree: false,
            },
          ],
        },
        {
          sessionID: "ses_parent_without_model",
          messageID: "msg_parent_without_model",
          agent: "implement",
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          ask: async () => undefined,
          metadata() {},
        },
      )

      if (!output.includes("model=zai-coding-plan/glm-5.2")) {
        console.error(`team fallback output did not expose GLM-5.2: ${output}`)
        process.exit(1)
      }
      if (model?.providerID !== "zai-coding-plan" || model?.modelID !== "glm-5.2") {
        console.error(`team fallback model was ${JSON.stringify(model)}, expected zai-coding-plan/glm-5.2`)
        process.exit(1)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  ' "$GUARDRAILS_PROFILE" >/dev/null
}

entrypoint_guardrails_smoke() {
  local dir output
  dir="$(mktemp -d)"
  printf 'TERM_PROGRAM=opencode-local-env-smoke\n' > "$dir/.env"
  output="$(cd "$dir" && env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_PURE -u TERM_PROGRAM -u TERM_PROGRAM_VERSION "$ENTRYPOINT" debug info)" || {
    rm -rf "$dir"
    return 1
  }
  rm -rf "$dir"

  grep -Fq "terminal: opencode-local-env-smoke" <<<"$output" &&
    grep -Fq "$GUARDRAILS_PROFILE/plugins/guardrail.ts" <<<"$output" &&
    grep -Fq "$GUARDRAILS_PROFILE/plugins/team.ts" <<<"$output"
}

zai_coding_plan_catalog_smoke() {
  local dir output
  dir="$(mktemp -d)"
  if ! output="$(
    cd "$dir" &&
      env \
        -u OPENCODE_CONFIG \
        -u OPENCODE_CONFIG_CONTENT \
        -u OPENCODE_CONFIG_DIR \
        -u OPENCODE_PURE \
        -u TERM_PROGRAM \
        -u TERM_PROGRAM_VERSION \
        HOME="$dir/home" \
        OPENCODE_DISABLE_MODELS_FETCH=1 \
        OPENCODE_TEST_HOME="$dir/home" \
        XDG_CACHE_HOME="$dir/cache" \
        XDG_CONFIG_HOME="$dir/config" \
        XDG_DATA_HOME="$dir/data" \
        XDG_STATE_HOME="$dir/state" \
        "$ENTRYPOINT" models "$ZAI_CODING_PLAN_PROVIDER"
  )"; then
    rm -rf "$dir"
    printf 'failed to query local runtime model catalog\n' >&2
    return 1
  fi
  rm -rf "$dir"

  if ! grep -Fxq "$ZAI_CODING_PLAN_MODEL_REF" <<<"$output"; then
    printf 'missing local runtime model: %s\n' "$ZAI_CODING_PLAN_MODEL_REF" >&2
    return 1
  fi
}

zai_coding_plan_variant_smoke() {
  local dir output model_json
  dir="$(mktemp -d)"
  if ! output="$(
    cd "$dir" &&
      env \
        -u OPENCODE_CONFIG \
        -u OPENCODE_CONFIG_CONTENT \
        -u OPENCODE_CONFIG_DIR \
        -u OPENCODE_PURE \
        -u TERM_PROGRAM \
        -u TERM_PROGRAM_VERSION \
        HOME="$dir/home" \
        OPENCODE_DISABLE_MODELS_FETCH=1 \
        OPENCODE_TEST_HOME="$dir/home" \
        XDG_CACHE_HOME="$dir/cache" \
        XDG_CONFIG_HOME="$dir/config" \
        XDG_DATA_HOME="$dir/data" \
        XDG_STATE_HOME="$dir/state" \
        "$ENTRYPOINT" models "$ZAI_CODING_PLAN_PROVIDER" --verbose
  )"; then
    rm -rf "$dir"
    printf 'failed to query local runtime verbose model catalog\n' >&2
    return 1
  fi
  rm -rf "$dir"

  model_json="$(awk -v model="$ZAI_CODING_PLAN_MODEL_REF" '
    $0 == model { capture = 1; next }
    capture && /^zai-coding-plan\// { exit }
    capture { print }
  ' <<<"$output")"
  if [[ -z "$model_json" ]]; then
    printf 'missing verbose model metadata: %s\n' "$ZAI_CODING_PLAN_MODEL_REF" >&2
    return 1
  fi
  if ! grep -Fq '"high"' <<<"$model_json" || ! grep -Fq '"reasoningEffort": "high"' <<<"$model_json"; then
    printf 'missing high reasoning variant for %s\n' "$ZAI_CODING_PLAN_MODEL_REF" >&2
    return 1
  fi
  if ! grep -Fq '"max"' <<<"$model_json" || ! grep -Fq '"reasoningEffort": "max"' <<<"$model_json"; then
    printf 'missing max reasoning variant for %s\n' "$ZAI_CODING_PLAN_MODEL_REF" >&2
    return 1
  fi
}

zai_coding_plan_default_smoke() {
  "$BUN_BIN" --eval '
    const config = await Bun.file(process.argv[1]).json()
    const expected = process.argv[2]
    const stale = process.argv[3]
    const provider = process.argv[4]
    const model = process.argv[5]
    if (config.model !== expected) {
      console.error(`guardrails profile default model is ${config.model ?? "missing"}, expected ${expected}`)
      process.exit(1)
    }
    if (config.model === stale) {
      console.error(`guardrails profile keeps stale default model: ${stale}`)
      process.exit(1)
    }
    const models = config.provider?.[provider]?.whitelist
    if (!Array.isArray(models) || !models.includes(model)) {
      console.error(`guardrails profile does not allow ${expected}`)
      process.exit(1)
    }
  ' "$GUARDRAILS_PROFILE/opencode.json" "$ZAI_CODING_PLAN_MODEL_REF" "$ZAI_CODING_PLAN_STALE_DEFAULT" "$ZAI_CODING_PLAN_PROVIDER" "$ZAI_CODING_PLAN_MODEL" >/dev/null
}

openrouter_catalog_smoke() {
  "$BUN_BIN" --eval '
    const [profile, managed, officialResponse, modelsDevResponse] = await Promise.all([
      Bun.file(process.argv[1]).json(),
      Bun.file(process.argv[2]).json(),
      fetch("https://openrouter.ai/api/v1/models"),
      fetch("https://models.dev/api.json"),
    ])

    if (!officialResponse.ok) {
      console.error(`OpenRouter models API returned HTTP ${officialResponse.status}`)
      process.exit(1)
    }
    if (!modelsDevResponse.ok) {
      console.error(`models.dev API returned HTTP ${modelsDevResponse.status}`)
      process.exit(1)
    }

    const official = await officialResponse.json()
    const modelsDev = await modelsDevResponse.json()
    const officialByID = new Map(official.data.map((item) => [item.id, item]))
    const modelsDevOpenRouter = modelsDev.openrouter?.models ?? {}
    const profileWhitelist = profile.provider?.openrouter?.whitelist
    const managedWhitelist = managed.provider?.openrouter?.whitelist
    if (!Array.isArray(profileWhitelist) || !Array.isArray(managedWhitelist)) {
      console.error("missing OpenRouter whitelist in guardrails profile or managed config")
      process.exit(1)
    }
    if (JSON.stringify(profileWhitelist) !== JSON.stringify(managedWhitelist)) {
      console.error("guardrails profile and managed OpenRouter whitelists differ")
      process.exit(1)
    }

    const missingOfficial = profileWhitelist.filter((id) => !officialByID.has(id))
    const missingModelsDev = profileWhitelist.filter((id) => modelsDevOpenRouter[id] === undefined)
    if (missingOfficial.length || missingModelsDev.length) {
      console.error(
        JSON.stringify(
          {
            missingOfficial,
            missingModelsDev,
          },
          null,
          2,
        ),
      )
      process.exit(1)
    }

    const latestFamilies = [
      ["anthropic-opus-4", /^anthropic\/claude-opus-4\./],
      ["google-gemini-3", /^google\/gemini-(?:3|3\.1|3\.5)/],
      ["minimax-m", /^minimax\/minimax-m(?:2\.\d+|3)$/],
      ["moonshot-kimi-k2", /^moonshotai\/kimi-k2/],
      ["openai-gpt-5", /^openai\/gpt-5/],
      ["qwen3-coder", /^qwen\/qwen3-coder/],
      ["qwen3-plus", /^qwen\/qwen3\.\d+-plus$/],
      ["qwen3-max", /^qwen\/qwen3\.\d+-max(?:-preview)?$/],
      ["qwen3-flash", /^qwen\/qwen3\.\d+-flash$/],
      ["deepseek-v", /^deepseek\/deepseek-v/],
      ["zai-glm", /^z-ai\/glm-/],
      ["xai-grok-4", /^x-ai\/grok-4/],
    ]
    const catalogBacked = Object.keys(modelsDevOpenRouter)
      .filter((id) => officialByID.has(id))
      .filter((id) => !id.includes(":free") && !id.startsWith("~"))
    const missingLatest = []
    for (const [name, pattern] of latestFamilies) {
      const candidates = catalogBacked
        .filter((id) => pattern.test(id))
        .map((id) => officialByID.get(id))
        .filter(Boolean)
      if (candidates.length === 0) continue
      const latestCreated = Math.max(...candidates.map((item) => Number(item.created) || 0))
      for (const item of candidates.filter((candidate) => Number(candidate.created) === latestCreated)) {
        if (!profileWhitelist.includes(item.id)) missingLatest.push(`${name}:${item.id}`)
      }
    }
    if (missingLatest.length) {
      console.error(`missing latest catalog-backed OpenRouter model(s): ${missingLatest.join(", ")}`)
      process.exit(1)
    }
  ' "$GUARDRAILS_PROFILE/opencode.json" "$MANAGED_PROFILE" >/dev/null
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
  local active_q guard_q bun_q local_db_q
  active_q=$(printf '%q' "$ACTIVE_BINARY")
  guard_q=$(printf '%q' "$GUARDRAILS_BIN")
  bun_q=$(printf '%q' "$BUN_BIN")
  local_db_q=$(printf '%q' "$LOCAL_DB")
  cat > "$LIVE_WRAPPER" <<EOF
#!/bin/zsh
export OPENCODE_BIN_PATH=$active_q
export OPENCODE_DB=\${OPENCODE_DB:-$local_db_q}
exec $bun_q $guard_q "\$@"
EOF
  chmod 755 "$LIVE_WRAPPER"

  # HIGH fix (review #205, codex): refuse to overwrite a regular file at
  # ENTRYPOINT or CACHED_BUNDLE; only replace symlinks or missing paths.
  ensure_symlink_target_safe "ENTRYPOINT" "$ENTRYPOINT"
  ensure_symlink_target_safe "CACHED_BUNDLE" "$CACHED_BUNDLE"

  ln -sfn "$LIVE_WRAPPER" "$ENTRYPOINT"
  ln -sfn "$CACHED_TARGET" "$CACHED_BUNDLE"
}

if [[ "$mode" == "check-zai-coding-plan" ]]; then
  mark "$(zai_coding_plan_catalog_smoke && echo ok || echo fail)" "local runtime exposes $ZAI_CODING_PLAN_MODEL_REF"
  mark "$(zai_coding_plan_variant_smoke && echo ok || echo fail)" "local runtime exposes $ZAI_CODING_PLAN_MODEL_REF high/max variants"
  mark "$(zai_coding_plan_default_smoke && echo ok || echo fail)" "guardrails profile defaults to $ZAI_CODING_PLAN_MODEL_REF"

  if [[ "$failures" -gt 0 ]]; then
    printf '\n%s Z.AI Coding Plan check(s) failed.\n' "$failures"
    exit 1
  fi

  printf '\nlocal Z.AI Coding Plan catalog/default scenario is fixed.\n'
  exit 0
fi

if [[ "$mode" == "check-openrouter-catalog" ]]; then
  mark "$(openrouter_catalog_smoke && echo ok || echo fail)" "OpenRouter whitelist matches live catalog and latest tracked families"

  if [[ "$failures" -gt 0 ]]; then
    printf '\n%s OpenRouter catalog check(s) failed.\n' "$failures"
    exit 1
  fi

  printf '\nlocal OpenRouter catalog freshness scenario is fixed.\n'
  exit 0
fi

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
mark "$(guardrails_team_fallback_smoke && echo ok || echo fail)" "guardrails team fallback uses $ZAI_CODING_PLAN_MODEL_REF"
mark "$(zai_coding_plan_catalog_smoke && echo ok || echo fail)" "local runtime exposes $ZAI_CODING_PLAN_MODEL_REF"
mark "$(zai_coding_plan_variant_smoke && echo ok || echo fail)" "local runtime exposes $ZAI_CODING_PLAN_MODEL_REF high/max variants"
mark "$(zai_coding_plan_default_smoke && echo ok || echo fail)" "guardrails profile defaults to $ZAI_CODING_PLAN_MODEL_REF"
mark "$(openrouter_catalog_smoke && echo ok || echo fail)" "OpenRouter whitelist matches live catalog and latest tracked families"

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
bun_q_check=$(printf '%q' "$BUN_BIN")
local_db_q_check=$(printf '%q' "$LOCAL_DB")
mark "$(grep -Fq "OPENCODE_BIN_PATH=$active_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper pins active binary"
mark "$(grep -Fq "OPENCODE_DB=\${OPENCODE_DB:-$local_db_q_check}" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper defaults stable local database: $LOCAL_DB"
mark "$(grep -Fq "exec $bun_q_check $guard_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper enters guardrails profile"

entry_version="$("$ENTRYPOINT" --version 2>/dev/null || true)"
active_version="$("$ACTIVE_BINARY" --version 2>/dev/null || true)"
mark "$([[ -n "$entry_version" && "$entry_version" == "$active_version" ]] && echo ok || echo fail)" "entrypoint version matches active binary: ${entry_version:-missing}"
mark "$(entrypoint_guardrails_smoke && echo ok || echo fail)" "entrypoint runs read-only command through guardrails profile/env"

if [[ "$failures" -gt 0 ]]; then
  printf '\n%s check(s) failed.\n' "$failures"
  if [[ "$mode" == "check" ]]; then
    printf 'Run: bun run local:fix\n'
  fi
  exit 1
fi

printf '\nlocal opencode deploy target is fixed.\n'
