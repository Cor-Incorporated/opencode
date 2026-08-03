---
name: lean-pipeline
description: Default to the minimal verification path; add heavy CI/review only after evidence (anti-patterns C/G).
---

# Lean pipeline

Prefer `/plan-light` defaults:

`fake/failing test → local unit → scoped CI → PR`

Add staging, multi-reviewer gates, or matrix expansion only after the minimal path missed a real defect. Docs/specs-only changes should not pull full e2e/nix suites when CI layering is available.
