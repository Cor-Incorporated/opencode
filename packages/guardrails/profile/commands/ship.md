---
description: Execute the merge workflow after all gates pass.
agent: ship
subtask: true
---

Execute the ship workflow for the current work:

1. Identify the current PR:
   - Run `gh pr list --head $(git branch --show-current)` to find the PR
   - If no PR exists, report "No PR found for current branch"

2. Verify all gates:
   - Run `gh pr checks <PR_NUMBER>` — all checks must pass
   - Run `gh pr view <PR_NUMBER> --json reviews` — no CHANGES_REQUESTED
   - Verify the guardrail review_state (the plugin enforces this at merge time)

3. If all gates pass:
   - Run `gh pr merge <PR_NUMBER> --merge`
   - Verify the merge succeeded with `gh pr view <PR_NUMBER> --json state`
   - Report: "PR #<N> merged successfully"

4. If any gate fails:
   - List each failing gate with evidence (CI output, review status)
   - Suggest specific remediation for each failure
   - Do NOT attempt to merge

Default scope is the current branch unless $ARGUMENTS specifies a PR number.

$ARGUMENTS
