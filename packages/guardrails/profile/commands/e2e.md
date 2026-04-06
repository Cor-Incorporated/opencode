---
description: Generate and run end-to-end tests with Playwright.
agent: implement
---

Create or run E2E tests using Playwright.

1. Identify the user flow to test from $ARGUMENTS.
2. Generate a Playwright test file covering the critical path.
3. Include assertions for visible UI state, not just network responses.
4. Run the test and capture results.
5. If tests fail, diagnose and fix the test or the application code.

Guidelines:
- E2E means browser-based verification — curl alone is NOT E2E.
- Prefer page.getByRole() and page.getByText() over CSS selectors.
- Add screenshot capture on failure for debugging.
- Keep tests independent — no shared state between test cases.

Required output:
- Test file location
- Pass/fail results
- Screenshots or traces (if failures occurred)

$ARGUMENTS
