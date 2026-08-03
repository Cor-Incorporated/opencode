---
name: impact-analysis
description: Enumerate reverse references before deleting or renaming symbols/files (anti-pattern A).
---

# Impact analysis

Before `git rm`, job deletion, or symbol rename:

1. List candidate paths/names.
2. Reverse-search references (`git grep`, workflow `needs:`, import graphs).
3. Record callers and name-based wiring (CI job IDs, plugin arrays, package names).
4. Only proceed when each reference has a replacement or an explicit waiver.
5. Prefer the removal-guard plugin proof: with the guard on, referenced deletions block; with `OPENCODE_REMOVAL_GUARD=off`, they pass.
