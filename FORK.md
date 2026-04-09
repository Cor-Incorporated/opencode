# Cor-Incorporated/opencode Fork

Upstream: [anomalyco/opencode](https://github.com/anomalyco/opencode)

## Fork-Only Systems

These features exist only in this fork, not in upstream:

| System | Path | Purpose |
|--------|------|---------|
| Shell Hook System | `packages/opencode/src/hook/` | PreToolUse/PostToolUse shell script hooks |
| Memory Extractor | `packages/opencode/src/memory/` | Session-based learning persistence |
| Guardrails Plugin | `packages/guardrails/` | Git workflow gates, auto-review, team orchestration |
| Notification | `packages/opencode/src/notification/` | Desktop notifications on session events |
| Repetition Detection | `packages/opencode/src/session/repetition.ts` | LLM loop detection |
| GLM Prompt | `packages/opencode/src/session/prompt/glm.txt` | ZhipuAI GLM provider support |
| AI Guardrails Docs | `docs/ai-guardrails/` | ADRs, issues, migration docs |

## Upstream Sync

Upstream merge is automated via `.gitattributes` `merge=ours` driver.
Fork-only paths are auto-protected during merge.

```bash
# One-time setup
git config merge.ours.driver true

# Sync
./scripts/upstream-sync.sh
```

### Conflict-Risk Files

These files are modified in both fork and upstream. Manual conflict resolution may be needed:

- `packages/opencode/src/config/config.ts` — fork adds hook/memory config
- `packages/opencode/src/index.ts` — fork adds hook/memory imports
- `packages/opencode/src/plugin/index.ts` — fork modifies plugin loading
- `packages/opencode/src/session/processor.ts` — fork adds memory extraction
- `packages/opencode/src/session/prompt.ts` — fork adds hook injection

## Sync History

| Date | Upstream Ref | Commits | Notes |
|------|-------------|---------|-------|
| 2026-04-08 | v1.4.0 | 37 | PR #136. Instance→InstanceState fix |
