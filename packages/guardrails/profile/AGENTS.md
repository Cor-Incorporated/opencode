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
