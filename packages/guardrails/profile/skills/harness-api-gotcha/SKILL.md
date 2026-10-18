---
name: harness-api-gotcha
description: Avoid vacuous tests caused by test-runner API limits (anti-pattern N). Use when writing DOM/event/async tests that appear to pass too easily.
---

# Harness API gotchas (pattern N)

Falsifiable-change (F) assumes the harness can deliver the signal under test. Some APIs silently drop properties and make every assertion a vacuous pass.

## Checklist before claiming green

1. **Does the harness deliver the event property?**
   - `fireEvent.keyDown(el, { isComposing: true })` does **not** set `nativeEvent.isComposing` (read-only on `KeyboardEvent`).
   - Prefer `el.dispatchEvent(new KeyboardEvent("keydown", { isComposing: true, bubbles: true }))`.
2. **Negative `waitFor` at 0ms** can pass without waiting — assert a positive observable change, or use a real delay/signal.
3. **Mock streams that resolve immediately** can flip `isRunning` false before assertions run — control microtasks / use deferred promises.
4. Falsify: temporarily break the production guard; the test must fail. If it still passes, the harness never exercised the path.

## Report

When you cannot falsify because of a harness limit, say so explicitly and change the harness (dispatch real events / pin timers) before claiming coverage.
