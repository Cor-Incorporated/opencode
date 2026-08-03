---
name: self-check
description: Prove objectivity with local wiring/falsify tests instead of another agent (anti-pattern H).
---

# Self-check (no external agent required)

Do not treat "ask Codex/Claude for a second opinion" as the objectivity proof.

Prefer:

1. Wiring tests that fail when a declaration and implementation diverge
2. Falsify toggles (`OPENCODE_*_GUARD=off`) that prove a guard catches the danger
3. Negative tests that prove safe operations still pass

External agents are optional review, never the sole evidence.
