---
description: Generate a hierarchy of AGENTS.md files across the project so agents pulling context from a deep subdirectory get the local guidance they need.
---

Run the hierarchical AGENTS.md generator from `packages/plugin/src/agents-md`.
The pipeline runs in four phases: Discovery → Scoring → Generate → Review/dedupe.

Arguments (parse from `$ARGUMENTS`, all optional):

- `--max-depth=N` — maximum traversal depth from the working directory (default: 4).
- `--create-new` — bypass the standard scoring threshold and emit at every directory with score >= 2.
- `--dry-run` — compute the plan and print it without writing any files.

Steps:

1. Parse `$ARGUMENTS` into `{ maxDepth, createNew, dryRun }`. Treat unknown flags as a hard error and stop with an explanation.
2. Invoke `runInitDeep({ cwd, maxDepth, createNew, dryRun })`.
3. If `--dry-run`:
   - Print the per-directory plan as a table: `<relPath>: score=<n>, action=<generate|update|skip>`.
   - Print the count of would-emit vs would-skip directories.
   - Do not write any files.
4. Otherwise:
   - Print a summary in the format:
     ```
     /init-deep complete:
       - <N> AGENTS.md files generated/updated
       - <M> directories skipped (low score)
       - <K> duplicate sections deduped
       - Total tokens added: ~<T>k
     ```
   - Print a final tree showing where AGENTS.md files now live (relative paths only).
5. The repo root AGENTS.md is always emitted, but its hand-written sections are preserved by the merge logic (sections marked `<!-- preserve -->` or any section name not in the auto list).
6. Never write to `node_modules/`, `.git/`, or any directory matching the always-excluded list.

$ARGUMENTS
