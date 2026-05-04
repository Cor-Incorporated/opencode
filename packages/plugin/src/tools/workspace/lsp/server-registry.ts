/**
 * Static map from file extension to LSP server invocation.
 *
 * Each entry records the binary, args, and project root marker filenames
 * used to locate the workspace root for the LSP `initialize` request.
 *
 * Extending this registry only requires adding a new {@link LspServerSpec}.
 */

import path from "node:path"

export interface LspServerSpec {
  /** Stable identifier reused as the cache key suffix. */
  language: string
  /** Executable name resolved against PATH. */
  command: string
  /** Args passed to the LSP binary. */
  args: string[]
  /** Filenames whose presence marks a workspace root. */
  rootPatterns: string[]
  /** LSP `languageId` field for `textDocument/didOpen`. */
  languageId: string
  /** Human-friendly install hint surfaced when binary is missing. */
  installHint: string
}

const TYPESCRIPT: LspServerSpec = {
  language: "typescript",
  command: "typescript-language-server",
  args: ["--stdio"],
  rootPatterns: ["tsconfig.json", "jsconfig.json", "package.json"],
  languageId: "typescript",
  installHint: "TypeScript LSP not found. Install: bun add -g typescript-language-server typescript",
}

const PYTHON: LspServerSpec = {
  language: "python",
  command: "pyright-langserver",
  args: ["--stdio"],
  rootPatterns: ["pyproject.toml", "setup.cfg", "setup.py", "requirements.txt"],
  languageId: "python",
  installHint: "Pyright LSP not found. Install: npm i -g pyright",
}

const GO: LspServerSpec = {
  language: "go",
  command: "gopls",
  args: ["serve"],
  rootPatterns: ["go.mod", "go.work"],
  languageId: "go",
  installHint: "gopls not found. Install: go install golang.org/x/tools/gopls@latest",
}

const RUST: LspServerSpec = {
  language: "rust",
  command: "rust-analyzer",
  args: [],
  rootPatterns: ["Cargo.toml"],
  languageId: "rust",
  installHint: "rust-analyzer not found. Install: rustup component add rust-analyzer",
}

const REGISTRY: Record<string, LspServerSpec> = {
  ".ts": { ...TYPESCRIPT, languageId: "typescript" },
  ".tsx": { ...TYPESCRIPT, languageId: "typescriptreact" },
  ".js": { ...TYPESCRIPT, languageId: "javascript" },
  ".jsx": { ...TYPESCRIPT, languageId: "javascriptreact" },
  ".mjs": { ...TYPESCRIPT, languageId: "javascript" },
  ".cjs": { ...TYPESCRIPT, languageId: "javascript" },
  ".py": PYTHON,
  ".pyi": PYTHON,
  ".go": GO,
  ".rs": RUST,
}

/**
 * Look up an LSP server spec for the given file path's extension.
 * Returns `null` when no language server is registered for the extension.
 */
export function specForFile(filePath: string): LspServerSpec | null {
  const ext = path.extname(filePath).toLowerCase()
  return REGISTRY[ext] ?? null
}

/**
 * For tests: list every registered extension.
 */
export function listExtensions(): string[] {
  return Object.keys(REGISTRY)
}
