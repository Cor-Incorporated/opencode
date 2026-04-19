---
description: Delegate work to parallel team workers.
agent: implement
---

Split the current task into parallel subtasks using the team tool.

1. Analyze the request to identify independent work streams.
2. For each stream, define: description, whether it writes code, dependencies on other tasks.
3. Call the `team` tool with the task list.
4. If the request is a single task, call `team` with one task (isolated worker delegation).

Guidelines:
- Mark tasks that edit code with `write: true` for git worktree isolation.
- Use `wave` strategy when tasks have dependencies.
- Use `parallel` strategy when all tasks are independent.
- Keep task count between 1 and 5 for manageability.
