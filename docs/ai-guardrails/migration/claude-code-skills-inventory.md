# Claude Asset Inventory

This document maps the source assets in `/Users/teradakousuke/Developer/claude-code-skills` into the thin-distribution plan for OpenCode.

It is intentionally philosophy-first. The migration is not "copy Claude hooks into a new runtime." The goal is to preserve the operating model while moving enforcement onto OpenCode-native extension points.

## Source Philosophy To Preserve

The migration must preserve these non-negotiable ideas from `claude-code-skills` README, epic `#130`, and the source ADRs:

- deterministic quality gates via mechanism, not prompt prose
- feedback speed hierarchy: fastest possible layer first
- pointer-based instructions: keep always-loaded instructions short and move detail to ADRs/docs
- "implemented" is not "working": deployment/runtime integrity must be verified as a system
- Codex and heavyweight automation are for bounded, mechanical, long-running work
- GitHub and release gates must not rely on agent goodwill alone

## Migration Rules

### Keep In `.claude`

- third-party Claude-only frameworks that OpenCode does not consume directly
- source-of-truth migration fixtures during the transition
- local reference assets used to compare behavior against the original harness

### Move To `.opencode`

- organization-owned `SKILL.md` assets that OpenCode can discover directly
- project-local commands, agents, and plugins
- runtime guardrails that belong in the OpenCode config/profile layer

### Move To `AGENTS.md` And `instructions`

- short routing rules
- prohibitions that point to plugins, commands, CI, or ADRs
- numeric thresholds and workflow entrypoints

### Move To CI Or Git Provider Policy

- merge gates
- review freshness requirements
- branch protection
- post-merge automations
- deployment verification that must remain authoritative outside the local client

### Drop

- Claude-specific hook deployment integrity logic
- settings-local hook override protection that exists only because of Claude's hook model
- features already covered by OpenCode runtime behavior or by the thin-distribution packaging model

## Skills

These skills are direct-reuse candidates. OpenCode already discovers `.claude/skills/*/SKILL.md`, so the first migration step is to keep them intact and only move them into `.opencode/skills/` when ownership, naming, and packaging are stable.

| Asset | Target | Notes |
|---|---|---|
| `adk-engineer` | direct keep | OpenCode-compatible `SKILL.md` asset. |
| `agent-orchestrator` | direct keep | High-value source for future safe-agent orchestration. |
| `brainstorming` | direct keep | Pure prompt asset. |
| `bugfix` | direct keep | Pure prompt asset. |
| `changelog-generator` | direct keep | Pure prompt asset. |
| `classify-review` | direct keep | Pure prompt asset; may later pair with GitHub command. |
| `code-reviewer` | direct keep | Core review asset. |
| `codex-review` | direct keep | Review asset that may later pair with wrapper commands. |
| `context7-skills` | direct keep | Prompt asset; tool wiring is separate. |
| `developer-growth-analysis` | direct keep | Prompt asset. |
| `file-organizer` | direct keep | Prompt asset. |
| `gcp-deploy-guardian` | direct keep | Prompt asset; runtime enforcement is separate. |
| `git-commit-helper` | direct keep | Prompt asset; commit gate remains outside skill. |
| `gws-workspace` | direct keep | Prompt asset. |
| `modern-architecture` | direct keep | Prompt asset. |
| `review-loop` | direct keep | Prompt asset; may later call OpenCode commands. |
| `security-review` | direct keep | Prompt asset. |
| `senior-architect` | direct keep | Prompt asset. |
| `senior-backend` | direct keep | Prompt asset. |
| `senior-frontend` | direct keep | Prompt asset. |
| `senior-fullstack` | direct keep | Prompt asset. |
| `skill-creator` | direct keep | Prompt asset. |
| `supabase-nextjs-debugger` | direct keep | Prompt asset. |
| `tdd-workflow` | direct keep | Prompt asset; gate logic moves elsewhere. |
| `test-falsify` | direct keep | Prompt asset. |
| `ui-design-system` | direct keep | Prompt asset. |
| `ui-skills` | direct keep | Prompt asset. |
| `ux-researcher-designer` | direct keep | Prompt asset. |

## Rules

Rules should not be copied verbatim into always-loaded OpenCode instructions. They should be compressed into pointers, with enforcement moved into plugins, commands, or CI.

| Asset | Target | Notes |
|---|---|---|
| `rules/coding-style.md` | `AGENTS.md` + plugin pointers | Keep short style constraints and point to plugin/CI for enforcement. |
| `rules/delegation.md` | `AGENTS.md` + commands | Turn routing into `/implement`, `/review`, `/handoff`, and safe-agent defaults. |
| `rules/git-workflow.md` | `AGENTS.md` + CI | Keep branch/PR policy as pointers; enforce in CI/provider policy. |
| `rules/hook-deployment.md` | ADR + tests | Keep the lesson from epic `#130`; do not recreate Claude deployment mechanics. |
| `rules/quality.md` | `AGENTS.md` + plugin + CI | Keep completion definition and fact-check rules as pointers. |
| `rules/testing.md` | `AGENTS.md` + commands + CI | Keep test doctrine short; enforce through `/ship` and CI. |

## Hooks

Bucket definitions:

- `plugin`: rewrite onto OpenCode plugin hooks, permissions, or session lifecycle
- `command`: rewrite as explicit slash-command or wrapper workflow
- `CI gate`: move to GitHub Actions / branch protection / server-side workflow gate
- `drop`: do not port directly; either Claude-specific or replaced by packaging/native behavior

| Hook | Target | Why |
|---|---|---|
| `audit-docker-build-args.sh` | plugin | Fast local shell policy check before risky docker commands. |
| `auto-init-permissions.sh` | drop | Replaced by managed config and packaged profile defaults. |
| `block-codex-mcp.sh` | drop | Codex-MCP-specific policy is not part of the target OpenCode runtime. |
| `block-local-hooks-write.sh` | plugin | Protect OpenCode config/profile files from unsafe local override edits. |
| `block-manual-merge-ops.sh` | command | Replace raw merge-path blocking with explicit `/ship` workflow. |
| `block-merge-without-ci.sh` | CI gate | Branch protection / Actions should remain authoritative. |
| `block-merge-without-review.sh` | CI gate | Review freshness belongs in GitHub policy, not local shell heuristics alone. |
| `block-state-file-tampering-bash.sh` | plugin | Direct safety block on shell writes to guardrail state. |
| `block-state-file-tampering.sh` | plugin | Direct safety block on edit/write access to guardrail state. |
| `block-version-downgrade.sh` | plugin | Fast local block before weakening runtime/package baselines. |
| `codex-task-gate.sh` | command | External Codex delegation should go through wrapper commands, not ad hoc shell. |
| `codex-task-release.sh` | command | Companion state transition for command-mediated Codex delegation. |
| `context-budget-agent-gate.sh` | plugin | Runtime decision at tool-call time. |
| `context-budget-edit-write-gate.sh` | plugin | Runtime decision at tool-call time. |
| `context-budget-read-gate.sh` | plugin | Runtime decision at tool-call time. |
| `context-budget-reset.sh` | plugin | Session lifecycle state reset belongs in plugin state. |
| `context-budget-write-gate.sh` | plugin | Runtime decision at tool-call time. |
| `enforce-architecture-layers.sh` | plugin | Fast local structural reminder after edits. |
| `enforce-branch-workflow.sh` | CI gate | Branch naming/protection should be authoritative in provider policy. |
| `enforce-codex-delegation.sh` | plugin | Advisory routing is best decided at runtime before agent/tool use. |
| `enforce-codex-for-impl.sh` | command | Use explicit `/implement` or delegation workflow instead of shell hooking. |
| `enforce-deploy-verify-on-pr.sh` | CI gate | Deployment verification should be server-side and reviewable. |
| `enforce-develop-base.sh` | CI gate | PR base enforcement belongs in provider workflow policy. |
| `enforce-doc-update-scope.sh` | plugin | Fast local reminder tied to changed files. |
| `enforce-domain-naming.sh` | plugin | Fast local reminder tied to edited paths. |
| `enforce-endpoint-dataflow.sh` | plugin | Immediate structural reminder after endpoint edits. |
| `enforce-factcheck-before-edit.sh` | plugin | Runtime guard before risky edits. |
| `enforce-factcheck-before-user-request.sh` | plugin | Runtime guard before requesting manual user actions. |
| `enforce-factcheck-github-ops.sh` | plugin | Runtime guard before GitHub write operations. |
| `enforce-follow-up-limit.sh` | CI gate | PR lineage policy should be authoritative in Git workflow automation. |
| `enforce-git-freshness.sh` | plugin | Session-start/runtime reminder in the local client. |
| `enforce-hook-deploy-after-merge.sh` | drop | Claude hook deployment concern disappears in packaged OpenCode profile model. |
| `enforce-hook-deploy-integrity.sh` | drop | Claude hook deployment concern disappears in packaged OpenCode profile model. |
| `enforce-issue-close-verification.sh` | command | Explicit close/ship workflow should require evidence-based acceptance checks. |
| `enforce-memory-update-on-commit.sh` | command | Commit workflow should carry this check explicitly. |
| `enforce-post-merge-validation.sh` | CI gate | Post-merge operational checks should survive local client differences. |
| `enforce-review-reading.sh` | plugin | Fast local reminder/block before risky merge-like operations. |
| `enforce-seed-data-verification.sh` | CI gate | Data-safety verification belongs in shared automation. |
| `enforce-soak-time.sh` | CI gate | Release timing policy belongs in server-side merge policy. |
| `git-commit-guard.sh` | command | Commit path should go through explicit workflow command. |
| `git-push-guard.sh` | CI gate | Push/branch enforcement should not rely on local hook presence. |
| `inject-claude-review-helper.py` | command | Keep as helper logic only if needed behind OpenCode review commands. |
| `inject-claude-review-on-checks.sh` | command | Rewrite as OpenCode/GitHub review workflow command. |
| `mark-factcheck-done.sh` | plugin | Runtime state transition after successful verification actions. |
| `post-deploy-verify.sh` | CI gate | Deployment verification must remain shared, visible automation. |
| `post-lint-format.sh` | plugin | Preserve fastest feedback layer with OpenCode-native hooks. |
| `post-merge-close-issues.sh` | CI gate | Post-merge GitHub automation belongs in Actions/app workflow. |
| `post-pr-create-review-trigger.sh` | CI gate | PR lifecycle automation belongs in Actions/app workflow. |
| `pr-ci-review-gate.sh` | CI gate | Central PR gate should move to GitHub workflow plus optional local preflight command. |
| `pr-guard.sh` | command | Local preflight belongs in explicit PR/ship command. |
| `pr-merge-claude-review-gate.sh` | CI gate | Merge gating belongs in provider workflow policy. |
| `pre-compact-context-save.sh` | plugin | OpenCode already exposes compaction hooks. |
| `protect-branches.sh` | CI gate | Branch protection should be authoritative in provider policy. |
| `protect-linter-config.sh` | plugin | Fast local block before config weakening edits. |
| `record-code-review.sh` | plugin | Runtime state recording after review agents complete. |
| `record-codex-review.sh` | plugin | Runtime state recording after delegated review completes. |
| `reset-factcheck.sh` | plugin | Session lifecycle reset belongs in plugin state. |
| `stop-test-gate.sh` | command | Rewrite as explicit completion/ship verification command. |
| `task-completion-gate.sh` | command | Rewrite as explicit completion/ship verification command. |
| `tool-failure-recovery.sh` | plugin | Runtime recovery assistance belongs in plugin lifecycle. |
| `track-agent-team.sh` | plugin | Runtime state tracking belongs in plugin lifecycle. |
| `validate-hook-deployment.sh` | drop | Claude hook deployment concern disappears in packaged OpenCode profile model. |
| `validate-no-local-hooks.sh` | drop | Claude settings-local hook override concern does not carry over directly. |
| `verify-agent-output.sh` | plugin | Runtime post-execution verification fits OpenCode plugin hooks. |
| `verify-codex-output.sh` | plugin | Runtime post-execution verification fits OpenCode plugin hooks. |
| `verify-state-file-integrity.sh` | plugin | Runtime post-execution verification fits OpenCode plugin hooks. |
| `verify-test-falsifiability.sh` | plugin | Fast local reminder after test file changes. |
| `workflow-sync-guard.sh` | CI gate | Workflow consistency is best enforced in shared CI. |

## Utility Scripts

| Asset | Target | Notes |
|---|---|---|
| `scripts/check-pr-reviews.sh` | CI gate | Server-side review freshness is more trustworthy. |
| `scripts/codex-orchestrate.sh` | command | Candidate backend for explicit delegation workflows. |
| `scripts/codex-parallel.sh` | command | Candidate backend for explicit delegation workflows. |
| `scripts/context-monitor.py` | drop | Useful as reference, not required for MVP OpenCode migration. |
| `scripts/delivery_score.py` | CI gate | Better as reporting/analytics than local runtime guard. |
| `scripts/verify-pr-review.sh` | CI gate | Server-side review verification should remain authoritative. |

## Immediate Implications For This Repo

- `Issue 001` should stay thin: wrapper, managed config, packaged profile.
- `Issue 002` is complete only when this inventory remains current and scenario coverage for `.claude/skills` stays green.
- `Issue 003` should focus on plugin rewrites that preserve fast feedback and system-level verifiability.
- `Issue 004` should turn command-bucket items into explicit safe workflows like `/implement`, `/review`, `/ship`, and `/handoff`.
- `Issue 005` should keep provider policy declarative and independent from one transient model brand.

## What Success Looks Like

Success is not "we copied most files."

Success is:

- OpenCode core remains close to upstream
- organization policy lives in profile/plugin/command/CI layers
- direct-reuse skills still work during migration
- important gates are verifiable in tests or CI
- no critical workflow depends on a hidden local hook deployment step
