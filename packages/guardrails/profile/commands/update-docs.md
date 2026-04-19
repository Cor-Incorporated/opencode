---
description: Update documentation to match current code state.
agent: implement
---

Review and update documentation affected by recent code changes.

1. Check git diff for recently modified files.
2. Grep for references to changed functions, APIs, or configs in documentation files.
3. Update README, AGENTS.md, ADRs, and inline docs to match the current state.
4. Verify no stale references remain.

Guidelines:
- Update docs in the same PR/commit as the code change when possible.
- Do not add documentation for unchanged code.
- Keep docs concise — match the existing documentation style.

Required output:
- Documentation files updated
- Stale references found and fixed
- Remaining documentation gaps (if any)

$ARGUMENTS
