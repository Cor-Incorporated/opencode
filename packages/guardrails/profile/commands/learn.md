---
description: Extract reusable patterns from the current codebase.
agent: planner
subtask: true
---

Analyze the codebase to identify and document reusable patterns.

1. Scan recent changes and existing code for recurring patterns.
2. Identify abstractions, conventions, or idioms worth documenting.
3. Check if similar patterns exist elsewhere that could be consolidated.
4. Document findings with file references and usage examples.

Guidelines:
- Focus on patterns that appear 3+ times — single occurrences are not patterns.
- Note anti-patterns and their better alternatives.
- Reference existing documentation to avoid duplication.

Required output:
- Patterns identified (with file:line references)
- Consolidation opportunities
- Anti-patterns found
- Recommended documentation updates

$ARGUMENTS
