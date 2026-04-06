---
description: UI component guidelines and constraints for building interfaces.
agent: implement
---

Provide opinionated UI constraints and guidelines for the current project.

1. Detect the UI framework and styling approach in use (React, Vue, Svelte, Tailwind, etc.).
2. Apply Tailwind CSS best practices — utility-first, consistent spacing scale, design tokens.
3. Enforce accessibility requirements — ARIA roles, keyboard navigation, color contrast, focus management.
4. Define animation guidelines — prefer CSS transitions, respect prefers-reduced-motion, keep durations under 300ms.
5. Establish responsive layout patterns — mobile-first breakpoints, fluid typography, container queries.
6. Guide component composition — single responsibility, prop drilling limits, slot/children patterns.

Guidelines:
- No inline styles — use Tailwind utilities or CSS modules.
- Interactive elements must have visible focus indicators.
- Images require alt text; decorative images use `alt=""`.
- Modals and dialogs must trap focus and support Escape to close.
- Color must not be the only indicator of state (use icons or text).

Apply constraints to the current context or the scope specified in $ARGUMENTS.

$ARGUMENTS
