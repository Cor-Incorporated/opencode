# Guardrails Distribution

This package is the thin internal distribution layer for the guardrails plan.

It should be understood as the Cor-Incorporated-specific layer that sits on top of upstream-compatible OpenCode, not as a separate reimplementation of the core runtime.

It keeps upstream OpenCode as the runtime and adds organization policy at the edges:

- `bin/opencode-guardrails` sets `OPENCODE_CONFIG_DIR` to the packaged profile and then delegates to the pinned `opencode` dependency
- `managed/opencode.json` is the admin-managed profile for system deployment
- `profile/` contains custom-dir assets such as `AGENTS.md`, commands, agents, and plugins

## Design intent

This package exists to preserve the operating model imported from `claude-code-skills` without turning OpenCode into a deep fork.

- mechanism-first guardrails
- fast feedback before slower workflow gates
- pointer-based instructions instead of bloated always-loaded prompts
- runtime verifiability over "the code exists, so it must work"

Those principles come from `claude-code-skills` epic `#130` and are tracked in this fork under `docs/ai-guardrails/`.

## Positioning

When describing this package or this fork externally, use wording close to:

- forked from OpenCode
- compatibility with upstream preserved where practical
- Cor-Incorporated-specific policy and workflow layer added in `packages/guardrails`

Avoid wording that implies this package replaces OpenCode itself. The intended architecture is still upstream engine plus thin internal distribution.

## Upstream strategy

- Keep this package version aligned with `packages/opencode/package.json`
- Upgrade upstream first, then update this package only where the extension surface changed
- Prefer `managed/` and `profile/` assets over core patches

## Current scope

Current contents focus on the first thin-distribution slice:

- packaged wrapper entrypoint
- managed enterprise defaults
- packaged custom config dir profile
- initial guardrail plugin for shell env injection, secret-path blocking, and compaction context

Planned next slices are tracked in the fork:

- epic [#1](https://github.com/Cor-Incorporated/opencode/issues/1)
- plugin MVP [#4](https://github.com/Cor-Incorporated/opencode/issues/4)
- safe agents and commands [#5](https://github.com/Cor-Incorporated/opencode/issues/5)
- provider policy [#6](https://github.com/Cor-Incorporated/opencode/issues/6)
- scenario/replay harness [#7](https://github.com/Cor-Incorporated/opencode/issues/7)

## Usage

Run the wrapper directly:

```sh
opencode-guardrails
```

It respects an existing `OPENCODE_CONFIG_DIR` so project- or environment-specific overrides can still replace the packaged profile when needed.

## Managed deployment

Copy [managed/opencode.json](/Users/teradakousuke/Developer/opencode/packages/guardrails/managed/opencode.json) into the system managed config directory:

- macOS: `/Library/Application Support/opencode/opencode.json`
- Linux: `/etc/opencode/opencode.json`
- Windows: `%ProgramData%\\opencode\\opencode.json`

For macOS MDM deployments, use the same keys in the `ai.opencode.managed` payload that OpenCode already reads through managed preferences.
