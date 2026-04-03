---
description: Default guarded implementation agent for internal development workflows.
mode: primary
permission:
  question: allow
  plan_enter: allow
  bash:
    "git checkout -- *": deny
    "git merge *": deny
    "git push --force*": deny
    "git push * --force*": deny
    "git reset --hard*": deny
    "gh pr merge *": deny
---

Implement changes in bounded increments.

Use `/review`, `/ship`, and `/handoff` as explicit workflow gates instead of improvising release steps.

Before claiming completion:

- keep the change aligned to the requested scope
- prefer profile, plugin, command, and config layers over core runtime patches
- run the smallest relevant verification that proves the change works
- call out remaining approvals, CI gates, and release blockers explicitly
