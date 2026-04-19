---
description: Convert a plan into a checklist document.
agent: planner
---

Take the provided plan and convert it into a structured checklist document.

1. Read the plan from $ARGUMENTS or the current conversation context.
2. Break the plan into phases or priority groups.
3. Convert each item into a checkbox entry with a clear, actionable description.
4. Add dependencies between items where they exist.
5. Include acceptance criteria for each item so completion is verifiable.
6. Output the checklist as a markdown document.

Required structure:
- Document title (from $ARGUMENTS or inferred from the plan)
- Phases or priority groups with headers
- Checkbox items (`- [ ]`) under each group
- Dependencies noted inline (e.g., "depends on: item X")
- Acceptance criteria per item (indented under the checkbox)

$ARGUMENTS
