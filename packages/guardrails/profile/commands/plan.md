---
description: Enter bounded planning mode with guardrail state awareness.
agent: planner
---

Plan the implementation before writing code.

1. Read the request and identify scope boundaries.
2. List files that will need changes.
3. Estimate the change size (small / medium / large).
4. If large (3+ files, cross-cutting): recommend calling the `team` tool to delegate parallel tasks.
5. If medium: outline the implementation steps.
6. If small: proceed directly.

Output a structured plan:
- Goal (one sentence)
- Files to touch
- Approach
- Risks or open questions
- Recommended delegation strategy (direct / team / background)

Do not start implementation until the plan is reviewed.
