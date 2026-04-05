# Coding Style

## Required
- Immutable: `return { ...obj, field }` — never mutate in place
- High cohesion, low coupling — organize by feature/domain
- Functions < 50 lines, files < 800 lines, nesting < 4 levels
- Validate inputs with Zod; use parameterized queries (no string concat for SQL)
- No `console.log` in production code; no hardcoded secrets — use env vars

## TypeScript
- Prefer `const` over `let`; never use `var`
- Use explicit return types on exported functions
- Prefer `Effect` patterns where the codebase uses them
- Use `namespace` + `interface` pattern consistent with this codebase (e.g., `Foo.Info`)

## Formatting
- Run `bunx prettier --write .` before committing (config in root `package.json`)
- Follow existing file structure conventions — check neighbors before creating new patterns
