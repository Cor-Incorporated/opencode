---
name: env-hermetic-tests
description: Pin env-gated auth/config in tests so ambient VITE_/Clerk keys cannot flip results (anti-pattern O).
---

# Env-hermetic tests (pattern O)

If production code branches on `isClerkConfigured`, `VITE_CLERK_PUBLISHABLE_KEY`, Firebase auth flags, etc., tests must **not** inherit the developer's shell env.

## Procedure

1. Grep the test (and imported helpers) for gate markers.
2. Pin via `vi.mock` / `vi.stubEnv` / hoisted runtime-config mock so both "configured" and "unconfigured" paths are explicit.
3. Re-run with the ambient key set and unset — results must match.
4. CI wiring: files that call those gates without a mock are violations (`needsEnvHermeticMock`).

Do not treat "passes on my machine" or "CI is green" alone as proof when the suite reads ambient publishable keys.
