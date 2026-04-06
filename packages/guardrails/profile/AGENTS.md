# Guardrail Profile

- Treat this profile as a thin distribution over upstream OpenCode.
- Prefer config, commands, agents, and plugins over core runtime patches.
- Prefer mechanism over prose: enforce with plugins, commands, permissions, and CI before adding more instruction text.
- Keep always-loaded instructions short and pointer-based; move detailed rationale into ADRs and docs.
- Keep skill-style progressive disclosure intact: brief routing text here, detailed rationale in docs, deterministic enforcement in plugins and commands.
- Push checks to the fastest reliable layer first, then fall back to command workflows and CI for authoritative gates.
- Keep project-local `.opencode` assets working; use them for repo-specific workflows instead of editing this profile unless the rule is organization-wide.
- Treat `.opencode/guardrails/` as plugin-owned runtime state, not a manual editing surface.
- Use `implement` as the guarded default primary agent. Route review, ship, and handoff work through the packaged `/review`, `/ship`, and `/handoff` commands instead of freeform release flows.
- Keep review paths read-only. If a workflow needs edits, return to `implement` or a project-local implementation agent instead of widening the review agent.
- All configured providers are available for standard work. The `provider-eval` agent and `/provider-eval` command remain available for dedicated evaluation workflows.

## Commands

| Command | Description |
|---------|-------------|
| `/review` | Run a read-only code review on the current diff or PR. |
| `/ship` | Merge-ready workflow: CI check, review gate, and push. |
| `/handoff` | Generate a handoff document for cross-session continuity. |
| `/plan` | Analyze requirements, assess risks, and produce a phased implementation plan. |
| `/investigate` | Systematic debugging with root cause analysis — spawns an exploration subagent. |
| `/test` | Run the TDD workflow: RED, GREEN, IMPROVE, then verify coverage. |
| `/delegate` | Route work to parallel subagents or Codex CLI based on task shape. |
| `/provider-eval` | Dedicated evaluation workflow for comparing configured providers. |

## Agents

### Primary agents

| Agent | Description |
|-------|-------------|
| `implement` | Default guarded agent for all implementation work. Edits, tests, and commits code within permission boundaries. |
| `provider-eval` | Evaluation-only agent for benchmarking and comparing LLM providers. |

### Subagents

| Agent | Trigger | Description |
|-------|---------|-------------|
| `planner` | `/plan`, complex feature requests | Read-only planning agent. Produces phased plans with risk assessment without modifying code. |
| `investigate` | `/investigate`, debugging tasks | Deep exploration subagent. Reads code, traces data flow, and identifies root causes without edits. |
| `security` | `/review` (security scope), OWASP checks | Security-focused review subagent. Scans for OWASP Top 10 vulnerabilities, credential leaks, and injection risks. |
| `code-reviewer` | `/review`, PR review pipeline | Read-only review agent. Analyzes diffs for quality, correctness, and style issues. |
