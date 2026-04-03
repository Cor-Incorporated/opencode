---
description: Run a release-readiness gate without edit access.
agent: review
subtask: true
---

Run a release-readiness check for the current work.

Required gates:

- the scope still matches the requested goal
- relevant verification has been run and cited
- risky shell or write operations did not bypass policy
- remaining approvals, CI, provider, or review gates are listed explicitly

Output:

- Ready or Not ready
- Evidence
- Blocking gates
- Next action

Default scope is the current uncommitted work unless `$ARGUMENTS` narrows it.
