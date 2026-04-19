---
description: Regenerate code maps and architecture documentation.
agent: implement
---

Update code maps to reflect the current codebase structure.

1. Scan the codebase for structural changes since the last update.
2. Regenerate architecture diagrams or dependency maps as needed.
3. Update any CODEMAPS or architecture docs.
4. Verify the maps accurately reflect imports, exports, and module boundaries.

Guidelines:
- Focus on structural accuracy over visual polish.
- Include only public interfaces in maps — skip internal helpers.
- Note any circular dependencies discovered during mapping.

Required output:
- Files updated or generated
- Key structural changes identified
- Circular dependencies (if any)

$ARGUMENTS
