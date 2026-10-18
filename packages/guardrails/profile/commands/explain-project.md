---
description: Explain the high-level architecture of the current project.
agent: planner
---

Analyze the project and explain its architecture.

1. Scan the project root for configuration files, entry points, and directory structure.
2. Identify main components, modules, and their responsibilities.
3. Trace data flow between components (API boundaries, state management, persistence).
4. Detect architecture patterns in use (MVC, hexagonal, event-driven, monorepo, etc.).
5. Map key dependencies and their roles.
6. Use multiple subagents if the project spans many packages or domains.

Required output:
- Architecture overview (one paragraph)
- Key files and directories (with purpose)
- Dependency graph (text or mermaid)
- Design patterns identified
- Data flow summary

$ARGUMENTS narrows scope to a specific area if provided.

$ARGUMENTS
