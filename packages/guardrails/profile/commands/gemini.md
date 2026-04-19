---
description: Web search using Gemini CLI for research.
agent: implement
---

Use the `gemini` CLI tool to perform web search and return synthesized results.

1. Take the search query from $ARGUMENTS.
2. Run `gemini` CLI with the provided query.
3. Parse and organize the search results.
4. Synthesize findings into actionable information relevant to the current task.
5. Cite sources where applicable.

Required output:
- Search query used
- Key findings (bulleted, ranked by relevance)
- Source references
- Actionable recommendations based on findings

$ARGUMENTS
