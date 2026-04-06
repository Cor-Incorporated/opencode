---
description: Read-only codebase investigation without editing files.
agent: review
subtask: true
---

Investigate the codebase to answer a question or diagnose an issue. This is a read-only operation.

1. Use read, grep, glob, and git log to gather evidence.
2. Trace execution paths relevant to the question.
3. Check related tests and documentation.

Required output:
- Summary (one paragraph)
- Evidence (file paths and line references)
- Root cause or answer
- Recommended next steps (but do not implement them)
