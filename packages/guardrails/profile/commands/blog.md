---
description: Generate a blog article from provided topic or context.
agent: implement
---

Write a technical blog post based on the provided topic.

1. Identify the topic from $ARGUMENTS or the current conversation context.
2. Research the topic within the codebase for concrete examples and code snippets.
3. Structure the post with a clear narrative arc.
4. Include code examples that are accurate and runnable.
5. Match the project's technical voice and terminology.

Required structure:
- Title
- Introduction (hook + what the reader will learn)
- Main sections (2-4 sections with headers, explanations, and code examples)
- Conclusion (summary + next steps or call to action)

Guidelines:
- Keep paragraphs short — 3-4 sentences maximum.
- Code examples must be syntax-highlighted with the correct language tag.
- Avoid jargon without explanation.
- Target length: 800-1500 words.

$ARGUMENTS
