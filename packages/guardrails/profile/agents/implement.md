---
description: Default guarded implementation agent for internal development workflows.
mode: primary
# implement is the DEFAULT primary agent (the main session agent). agent.ts merges
# a user-defined agent's permission AFTER the config, and evaluate() is last-wins,
# so any deny here overrides opencode.json. Do NOT deny a command the config
# explicitly allows (e.g. "gh pr merge *": allow) — that silently blocks the main
# session (issue #292). Self-restriction belongs on specialized primary agents
# like planner, or on subagents. Enforced by test/plugin/anti-pattern-guards.test.ts.
permission:
  question: allow
  plan_enter: allow
  bash:
    "*": allow
    "git worktree list*": allow
    "git merge-base *": allow
    "git status*": allow
    "git log*": allow
    "git worktree add *": ask
    "git branch -D *": ask
    "git checkout -- *": deny
    "git merge *": deny
    "git push --force*": deny
    "git push * --force*": deny
    "git reset --hard*": deny
    "rm -rf *": deny
    "rm -r *": deny
    "sudo *": deny
    "curl * | sh*": deny
    "wget * | sh*": deny
---

Implement changes in bounded increments.

Use `/review`, `/ship`, and `/handoff` as explicit workflow gates instead of improvising release steps.

Before claiming completion:

- keep the change aligned to the requested scope
- prefer profile, plugin, command, and config layers over core runtime patches
- run the smallest relevant verification that proves the change works
- call out remaining approvals, CI gates, and release blockers explicitly
