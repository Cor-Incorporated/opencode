# ADR 007: Multi-Model Delegation Gates

## Status

Accepted

## Context

Claude Code routes all tasks to a single provider (Anthropic) via Codex delegation gates (7 hooks). OpenCode supports multiple providers (ZAI, OpenAI, Anthropic via OpenRouter, Google, etc.) and can assign different models per agent via `agent.model`.

This multi-model capability is OpenCode's primary competitive advantage. However, without guardrails, agents may be assigned suboptimal models (expensive models for trivial tasks, weak models for complex tasks), parallel execution may exceed rate limits, and costs may spiral without visibility.

## Decision

Add five delegation gates to `guardrail.ts` that leverage OpenCode's multi-provider architecture:

### 1. agent-model-mapping (chat.params)
Advisory that logs when an agent is running on a model tier that doesn't match its expected workload. Three tiers: high (implement, security, architect), standard (review, tdd, build-error), low (explore, doc-updater, investigate).

### 2. delegation-budget-gate (tool.execute.before for task)
Hard block that limits concurrent parallel tasks to `maxParallelTasks` (default 5). Tracks `active_task_count` in state.json, incremented on task start and decremented on task completion.

### 3. cost-tracking (chat.params)
Counts `llm_call_count` per session and tracks `llm_calls_by_provider` for per-provider cost visibility. Actual cost calculation requires post-call usage data not available at chat.params time.

### 4. parallel-execution-gate (tool.execute.before for task)
Integrated with delegation-budget-gate. Prevents unbounded parallel execution that could hit provider rate limits.

### 5. verify-agent-output (tool.execute.after for task)
Advisory that detects trivially short agent output (< 20 characters), indicating the agent may have failed silently.

## Mapping to Claude Code Codex Gates

| Claude Code | OpenCode | Evolution |
|---|---|---|
| codex-task-gate | delegation-budget-gate | Single Codex → any provider |
| codex-model-gate | agent-model-mapping | Fixed model → per-agent tier |
| codex-parallel-gate | parallel-execution-gate | Same + per-provider limits |
| codex-cost-gate | cost-tracking | Codex API → all providers |
| codex-output-gate | verify-agent-output | Equivalent |

## Consequences

### Positive

- OpenCode gains structured cost visibility across all providers
- Unbounded parallel execution is prevented
- Model-agent mismatch is logged for optimization
- The pattern extends naturally to per-provider rate limits in future

### Negative

- `active_task_count` tracking may drift if a task crashes without completing the after hook; periodic reconciliation may be needed
- Tier assignments are static; dynamic assignment based on task complexity would be more accurate but requires deeper integration

## Sources

- `packages/opencode/src/tool/task.ts` — task delegation with agent model override
- `packages/opencode/src/agent/agent.ts` — agent model field and config merge
- `@opencode-ai/plugin` — Hooks interface (chat.params, tool.execute.before/after)
- Claude Code Codex delegation gates (7 hooks) — reference implementation
