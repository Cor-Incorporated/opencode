---
description: Review current work with the read-only guardrail review agent.
agent: review
subtask: true
---

Review the current work for correctness, regressions, missing tests, and missing workflow gates.

For AI agent instrumentation or metrics, verify source-level hooks, no global monkey patches, a traceability matrix, integration/smoke tests, metric semantics with code paths, dependency availability probes, resource cleanup/finally paths, and explicit unavailable reasons instead of null.

Required sections:

- Findings
- Verification
- Open risks
- Recommended next step

Default scope is the current uncommitted work unless `$ARGUMENTS` narrows it.
