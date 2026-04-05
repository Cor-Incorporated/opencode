# Testing

## Coverage
- Target: 80%+ (unit + integration + E2E combined)

## Test Levels
- Unit: `bun --cwd packages/opencode test` or `bun turbo test:ci` — isolated logic, pure functions
- Integration: HTTP client tests — API endpoints, service interactions
- E2E: Playwright or manual browser — never report curl tests as E2E

## TDD Workflow
- RED: write a failing test first
- GREEN: write minimal code to pass
- IMPROVE: refactor while keeping tests green
- Verify coverage after each cycle

## Falsifiability
- Every test must fail when the bug it guards against is reintroduced
- If a test passes regardless of the bug's presence, it is not a valid test
