# Guardrail Profile

- Treat this profile as a thin distribution over upstream OpenCode.
- Prefer config, commands, agents, and plugins over core runtime patches.
- Prefer mechanism over prose: enforce with plugins, commands, permissions, and CI before adding more instruction text.
- Keep always-loaded instructions short and pointer-based; move detailed rationale into ADRs and docs.
- Push checks to the fastest reliable layer first, then fall back to command workflows and CI for authoritative gates.
- Keep project-local `.opencode` assets working; use them for repo-specific workflows instead of editing this profile unless the rule is organization-wide.
- Default to review and explicit workflow gates before shipping changes.
