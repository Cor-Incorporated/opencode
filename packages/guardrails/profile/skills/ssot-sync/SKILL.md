---
name: ssot-sync
description: Keep mirrored SSOT artifacts in sync when changing migrations, contracts, or version pins (anti-pattern K). Use beside impact-analysis for duplicate definitions.
---

# SSOT sync (pattern K)

Impact analysis finds **references**. SSOT sync finds **duplicate definitions** that must share one final state.

## Before / while changing a mirrored artifact

1. Identify the mirror set (db-schema / version-pins / api-contract, or project `.opencode/guardrails/ssot-mirrors.json`).
2. Grep every side of the set — not only the file you are editing.
3. Update all sides in the same change.
4. Run `/ssot-check` (or the repo contract comparison) locally before PR.
5. Prove version pins with an equality assert across every declaration file.

## Remember

- Zero reverse references does **not** mean safe to drop from only one side (indexes in `initial-schema.sql` are definitions, not callers).
- `ci:v2:schema`-style static checks may pass while migrate-vs-SSOT still fails — run the comparison that CI uses.
- The SSOT plugin advises; it does not hard-block (pattern I). Disabling via `OPENCODE_SSOT_GUARD=off` removes the advisory (falsify).
