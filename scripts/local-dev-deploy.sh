#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/packages/opencode"
GUARDRAILS_BIN="$ROOT/packages/guardrails/bin/opencode-guardrails"
GUARDRAILS_PROFILE="$ROOT/packages/guardrails/profile"
ALLOWED_WRITE_ROOT="$HOME/.local/bin"
ENTRYPOINT="${OPENCODE_LOCAL_ENTRYPOINT:-$ALLOWED_WRITE_ROOT/opencode}"
LIVE_WRAPPER="${OPENCODE_LOCAL_WRAPPER:-$ALLOWED_WRITE_ROOT/opencode-live-guardrails-wrapper}"
LIVE_WRAPPER_MANIFEST="${OPENCODE_LOCAL_WRAPPER_MANIFEST:-$ALLOWED_WRITE_ROOT/opencode-live-guardrails-wrapper.json}"
LOCAL_DB="${OPENCODE_LOCAL_DB:-opencode-local.db}"
GLOBAL_CONFIG_DIR="${OPENCODE_GLOBAL_CONFIG_DIR:-$HOME/.config/opencode}"
GLOBAL_PLUGIN_DIR="$GLOBAL_CONFIG_DIR/plugins"
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

managed_global_guardrail_target() {
  case "$1" in
    git-guard.ts|guardrail.ts|team.ts) printf '%s/plugins/%s\n' "$GUARDRAILS_PROFILE" "$1" ;;
    *) return 1 ;;
  esac
}

guardrails_profile_symlink_target() {
  local name="$1"
  local target="$2"
  case "$target" in
    "$GUARDRAILS_PROFILE/plugins/$name"|*/packages/guardrails/profile/plugins/"$name") return 0 ;;
    *) return 1 ;;
  esac
}

ensure_global_guardrail_plugin_repairable() {
  local name="$1"
  local file="$GLOBAL_PLUGIN_DIR/$name"
  local target
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    return 0
  fi
  if [[ ! -L "$file" ]]; then
    echo "refusing to replace existing non-symlink global guardrail plugin: $file" >&2
    return 1
  fi
  target="$(readlink "$file" 2>/dev/null || true)"
  if [[ "$target" == "$(managed_global_guardrail_target "$name")" ]]; then
    return 0
  fi
  if guardrails_profile_symlink_target "$name" "$target"; then
    return 0
  fi
  echo "refusing to replace unknown global plugin symlink: $file -> $target" >&2
  return 1
}

repair_global_guardrail_plugins() {
  mkdir -p "$GLOBAL_PLUGIN_DIR"
  local name
  for name in guardrail.ts team.ts git-guard.ts; do
    ensure_global_guardrail_plugin_repairable "$name"
    ln -sfn "$(managed_global_guardrail_target "$name")" "$GLOBAL_PLUGIN_DIR/$name"
  done
}

global_guardrail_plugins_clean() {
  local name file expected target
  for name in guardrail.ts team.ts git-guard.ts; do
    file="$GLOBAL_PLUGIN_DIR/$name"
    expected="$(managed_global_guardrail_target "$name")"
    if [[ ! -L "$file" ]]; then
      echo "global guardrail plugin is not a managed symlink: $file" >&2
      return 1
    fi
    target="$(readlink "$file" 2>/dev/null || true)"
    if [[ "$target" != "$expected" ]]; then
      echo "global guardrail plugin points at stale target: $file -> $target, expected $expected" >&2
      return 1
    fi
  done
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
  bun run local:assert-not-pinned -- <worktree-path>
  bash scripts/local-dev-deploy.sh [--check|--fix|--no-build|--assert-not-pinned <worktree-path>|--check-zai-coding-plan|--check-openrouter-catalog]

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
  --assert-not-pinned <worktree-path>
              fail if the local wrapper currently points inside that worktree
EOF
}

mode="deploy"
assert_not_pinned_target=""
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --fix|--no-build) mode="fix" ;;
  --assert-not-pinned)
    mode="assert-not-pinned"
    if [[ "${2:-}" == "--" ]]; then
      assert_not_pinned_target="${3:-}"
    else
      assert_not_pinned_target="${2:-}"
    fi
    ;;
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
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")

    const profile = process.argv[1]
    const ctxMod = await import(pathToFileURL(join(profile, "plugins/guardrail-context.ts")).href)
    const gitMod = await import(pathToFileURL(join(profile, "plugins/guardrail-git.ts")).href)
    const dir = await mkdtemp(join(tmpdir(), "opencode-local-policy-check-"))
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_policy_smoke" } }),
        promptAsync: async () => ({}),
        prompt: async () => ({}),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        abort: async () => ({}),
      },
    }
    try {
      const ctx = await ctxMod.createContext({ client, directory: dir, worktree: dir }, { mode: "enforced" })
      const git = gitMod.createGitHandlers(ctx)
      await Bun.$`git init`.cwd(dir).quiet()
      await Bun.$`git config core.fsmonitor false`.cwd(dir).quiet()
      await Bun.$`git config commit.gpgsign false`.cwd(dir).quiet()
      await Bun.$`git config user.email "local-check@opencode.test"`.cwd(dir).quiet()
      await Bun.$`git config user.name "OpenCode Local Check"`.cwd(dir).quiet()
      await Bun.$`git commit --allow-empty -m root`.cwd(dir).quiet()
      await Bun.$`git branch -M main`.cwd(dir).quiet()

      try {
        await git.bashBeforeGit("git push origin main", {}, {})
        console.error("guardrail-git minimal policy smoke should block protected push")
        process.exit(1)
      } catch (err) {
        if (!String(err).includes("protected branch")) {
          console.error(`guardrail-git minimal policy smoke blocked for wrong reason: ${String(err)}`)
          process.exit(1)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  ' "$GUARDRAILS_PROFILE" >/dev/null
}

guardrails_aggregate_policy_fire_smoke() {
  "$BUN_BIN" --conditions=browser --eval '
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")

    const profile = process.argv[1]
    const dir = await mkdtemp(join(tmpdir(), "opencode-local-aggregate-policy-"))
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_unused_local_aggregate" } }),
        promptAsync: async () => ({}),
        prompt: async () => ({}),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        abort: async () => ({}),
      },
    }

    async function state() {
      return await Bun.file(join(dir, ".opencode/guardrails/state.json")).json()
    }

    try {
      const mod = await import(pathToFileURL(join(profile, "plugins/guardrail.ts")).href)
      const plugin = await mod.default({ client, directory: dir, worktree: dir }, {})

      await Bun.$`git init`.cwd(dir).quiet()
      await Bun.$`git config core.fsmonitor false`.cwd(dir).quiet()
      await Bun.$`git config commit.gpgsign false`.cwd(dir).quiet()
      await Bun.$`git config user.email "local-check@opencode.test"`.cwd(dir).quiet()
      await Bun.$`git config user.name "OpenCode Local Check"`.cwd(dir).quiet()
      await Bun.$`git commit --allow-empty -m root`.cwd(dir).quiet()
      await Bun.$`git branch -M main`.cwd(dir).quiet()

      await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_aggregate_policy" } } })
      const initialized = await state()
      if (initialized.workflow_phase !== "idle" || initialized.review_glm_state !== "") {
        console.error(`aggregate guardrail session.created initialized unexpected state: ${JSON.stringify(initialized)}`)
        process.exit(1)
      }

      try {
        await plugin["tool.execute.before"](
          { tool: "bash", args: { command: "git push origin main" } },
          { args: { command: "git push origin main" } },
        )
        console.error("aggregate guardrail protected push should block")
        process.exit(1)
      } catch (err) {
        if (!String(err).includes("protected branch")) {
          console.error(`aggregate guardrail protected push blocked for wrong reason: ${String(err)}`)
          process.exit(1)
        }
      }

      await plugin["tool.execute.before"](
        { tool: "bash", args: { command: "git status --short" } },
        { args: { command: "git status --short" } },
      )
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
    grep -Fq "$GUARDRAILS_PROFILE/plugins/team.ts" <<<"$output" &&
    ! grep -Fq "$GLOBAL_PLUGIN_DIR/guardrail.ts" <<<"$output" &&
    ! grep -Fq "$GLOBAL_PLUGIN_DIR/git-guard.ts" <<<"$output" &&
    ! grep -Fq "$GUARDRAILS_PROFILE/plugins/guardrail-git.ts" <<<"$output" &&
    ! grep -Fq "$GUARDRAILS_PROFILE/plugins/guardrail-review.ts" <<<"$output" &&
    ! grep -Fq "external plugins disabled" <<<"$output" &&
    ! grep -Fq "plugins: none" <<<"$output"
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
  require_under_allowed_root "LIVE_WRAPPER_MANIFEST" "$LIVE_WRAPPER_MANIFEST"
  if [[ -L "$LIVE_WRAPPER_MANIFEST" ]]; then
    echo "refusing to replace symlinked LIVE_WRAPPER_MANIFEST: $LIVE_WRAPPER_MANIFEST" >&2
    exit 2
  fi

  # HIGH fix (review #205, codex): shell-escape paths in the heredoc so that
  # spaces or metacharacters in repo path / GUARDRAILS_BIN cannot break the
  # generated wrapper or inject shell.
  local active_q guard_q bun_q local_db_q profile_q
  active_q=$(printf '%q' "$ACTIVE_BINARY")
  guard_q=$(printf '%q' "$GUARDRAILS_BIN")
  bun_q=$(printf '%q' "$BUN_BIN")
  local_db_q=$(printf '%q' "$LOCAL_DB")
  profile_q=$(printf '%q' "$GUARDRAILS_PROFILE")
  cat > "$LIVE_WRAPPER" <<EOF
#!/bin/zsh
# opencode-local-wrapper-repo-root: $ROOT
# opencode-local-wrapper-active-binary: $ACTIVE_BINARY
# opencode-local-wrapper-guardrails-bin: $GUARDRAILS_BIN
export OPENCODE_BIN_PATH=$active_q
export OPENCODE_DB=\${OPENCODE_DB:-$local_db_q}
export OPENCODE_LOCAL_GUARDRAILS_PROFILE=$profile_q
exec $bun_q $guard_q "\$@"
EOF
  chmod 755 "$LIVE_WRAPPER"

  "$BUN_BIN" --eval '
    await Bun.write(
      process.argv[1],
      `${JSON.stringify(
        {
          repo_root: process.argv[2],
          active_binary: process.argv[3],
          guardrails_bin: process.argv[4],
          entrypoint: process.argv[5],
          live_wrapper: process.argv[6],
          local_db: process.argv[7],
          local_guardrails_profile: process.argv[8],
        },
        null,
        2,
      )}\n`,
    )
  ' "$LIVE_WRAPPER_MANIFEST" "$ROOT" "$ACTIVE_BINARY" "$GUARDRAILS_BIN" "$ENTRYPOINT" "$LIVE_WRAPPER" "$LOCAL_DB" "$GUARDRAILS_PROFILE"

  # HIGH fix (review #205, codex): refuse to overwrite a regular file at
  # ENTRYPOINT or CACHED_BUNDLE; only replace symlinks or missing paths.
  ensure_symlink_target_safe "ENTRYPOINT" "$ENTRYPOINT"
  ensure_symlink_target_safe "CACHED_BUNDLE" "$CACHED_BUNDLE"

  ln -sfn "$LIVE_WRAPPER" "$ENTRYPOINT"
  ln -sfn "$CACHED_TARGET" "$CACHED_BUNDLE"
}

wrapper_manifest_matches() {
  "$BUN_BIN" --eval '
    const data = await Bun.file(process.argv[1]).json()
    const expected = {
      repo_root: process.argv[2],
      active_binary: process.argv[3],
      guardrails_bin: process.argv[4],
      entrypoint: process.argv[5],
      live_wrapper: process.argv[6],
      local_db: process.argv[7],
      local_guardrails_profile: process.argv[8],
    }
    const mismatches = Object.entries(expected).filter(([key, value]) => data[key] !== value)
    if (mismatches.length) {
      console.error(
        `wrapper manifest mismatch: ${mismatches.map(([key, value]) => `${key}=${JSON.stringify(data[key])}, expected=${JSON.stringify(value)}`).join("; ")}`,
      )
      process.exit(1)
    }
  ' "$LIVE_WRAPPER_MANIFEST" "$ROOT" "$ACTIVE_BINARY" "$GUARDRAILS_BIN" "$ENTRYPOINT" "$LIVE_WRAPPER" "$LOCAL_DB" "$GUARDRAILS_PROFILE" >/dev/null
}

assert_not_pinned() {
  local target="$1"
  local resolved
  if [[ -z "$target" ]]; then
    echo "missing worktree path for --assert-not-pinned" >&2
    exit 2
  fi
  resolved="$(cd "$target" 2>/dev/null && pwd -P || true)"
  if [[ -z "$resolved" ]]; then
    echo "cannot resolve worktree path: $target" >&2
    exit 2
  fi

  "$BUN_BIN" --eval '
    const path = await import("node:path")
    const { readFile, readlink } = await import("node:fs/promises")

    const targets = [...new Set([path.resolve(process.argv[1]), path.resolve(process.argv[2])])]
    const target = targets[0]
    const manifestPath = process.argv[3]
    const wrapperPath = process.argv[4]
    const entrypointPath = process.argv[5]
    const blockers = []
    const underTarget = (value) => {
      const resolved = path.resolve(value)
      return targets.some((candidate) => {
        const prefix = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`
        return resolved === candidate || resolved.startsWith(prefix)
      })
    }

    const manifestText = await readFile(manifestPath, "utf8").catch(() => "")
    if (manifestText) {
      const data = JSON.parse(manifestText)
      for (const key of ["repo_root", "active_binary", "guardrails_bin"]) {
        if (typeof data[key] === "string" && underTarget(data[key])) blockers.push(`${key}: ${data[key]}`)
      }
    }

    const wrapper = await readFile(wrapperPath, "utf8").catch(() => "")
    if (
      targets.some((candidate) => {
        const prefix = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`
        const escapedTarget = candidate.replaceAll(" ", "\\ ")
        return wrapper.includes(prefix) || wrapper.includes(`${escapedTarget}${path.sep}`)
      })
    ) {
      blockers.push(`wrapper text references ${target}`)
    }

    const entrypointTarget = await readlink(entrypointPath).catch(() => "")
    if (entrypointTarget) {
      const resolved = path.resolve(path.dirname(entrypointPath), entrypointTarget)
      if (underTarget(resolved)) {
        blockers.push(`entrypoint symlink: ${entrypointPath} -> ${entrypointTarget}`)
      }
    }

    if (blockers.length) {
      console.error(`refusing to remove pinned local opencode worktree: ${target}`)
      for (const blocker of blockers) console.error(`- ${blocker}`)
      console.error("Run local:deploy/local:check from a retained worktree, then retry this check.")
      process.exit(1)
    }
  ' "$resolved" "$target" "$LIVE_WRAPPER_MANIFEST" "$LIVE_WRAPPER" "$ENTRYPOINT"
}

if [[ "$mode" == "assert-not-pinned" ]]; then
  assert_not_pinned "$assert_not_pinned_target"
  printf 'worktree is not pinned by local opencode wrapper: %s\n' "$assert_not_pinned_target"
  exit 0
fi

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
if [[ "$mode" == "deploy" || "$mode" == "fix" ]]; then
  repair_global_guardrail_plugins
fi

mark "$([[ -x "$GUARDRAILS_BIN" ]] && echo ok || echo fail)" "guardrails wrapper is executable"
mark "$(grep -Fq "OPENCODE_CONFIG_DIR" "$GUARDRAILS_BIN" 2>/dev/null && echo ok || echo fail)" "guardrails wrapper sets OPENCODE_CONFIG_DIR"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/auto.md" ]] && echo ok || echo fail)" "guardrails profile includes /auto"
mark "$([[ -f "$GUARDRAILS_PROFILE/commands/plan.md" ]] && echo ok || echo fail)" "guardrails profile includes /plan"
mark "$(guardrails_profile_has_team_plugin && echo ok || echo fail)" "guardrails profile enables guardrail and team plugins"
mark "$(guardrails_policy_plugins_smoke && echo ok || echo fail)" "guardrails review/git policy smoke passes"
mark "$(guardrails_aggregate_policy_fire_smoke && echo ok || echo fail)" "guardrails aggregate plugin fires review/git/UAT policy hooks"
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
profile_q_check=$(printf '%q' "$GUARDRAILS_PROFILE")
mark "$(grep -Fq "OPENCODE_BIN_PATH=$active_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper pins active binary"
mark "$(grep -Fq "OPENCODE_DB=\${OPENCODE_DB:-$local_db_q_check}" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper defaults stable local database: $LOCAL_DB"
mark "$(grep -Fq "OPENCODE_LOCAL_GUARDRAILS_PROFILE=$profile_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper filters managed global guardrails profile"
mark "$(grep -Fq "exec $bun_q_check $guard_q_check" "$LIVE_WRAPPER" 2>/dev/null && echo ok || echo fail)" "live wrapper enters guardrails profile"
mark "$(wrapper_manifest_matches && echo ok || echo fail)" "live wrapper manifest pins current worktree safely"
mark "$(global_guardrail_plugins_clean && echo ok || echo fail)" "managed global guardrail plugin symlinks point at current profile"

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
