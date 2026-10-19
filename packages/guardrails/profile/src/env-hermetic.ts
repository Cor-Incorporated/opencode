/**
 * Pattern O: tests that exercise env-gated auth/config paths must pin those
 * gates via mocks — ambient VITE_* / Clerk keys must not decide pass/fail.
 */

export const AUTH_GATE_MARKERS = [
  /isClerkConfigured\b/,
  /isFirebaseAuthConfigured\b/,
  /\bVITE_CLERK_PUBLISHABLE_KEY\b/,
  /\bCLERK_PUBLISHABLE_KEY\b/,
  /\bVITE_FIREBASE\w*\b/,
]

export const HERMETIC_MOCK_MARKERS = [
  /\bvi\.mock\s*\(/,
  /\bjest\.mock\s*\(/,
  /\bvi\.stubEnv\s*\(/,
  /\bvi\.hoisted\s*\(/,
  /mock(?:RuntimeConfig|Auth|Clerk)/i,
  /runtime-config/,
]

export function usesEnvGatedPath(source: string) {
  return AUTH_GATE_MARKERS.some((pattern) => pattern.test(source))
}

export function hasHermeticMock(source: string) {
  return HERMETIC_MOCK_MARKERS.some((pattern) => pattern.test(source))
}

/** True when a test file needs an env hermeticity fix (gate used, no mock). */
export function needsEnvHermeticMock(source: string) {
  return usesEnvGatedPath(source) && !hasHermeticMock(source)
}

export function envHermeticAdvisory(files: string[]) {
  if (!files.length) return
  return (
    `⚠️ [ENV HERMETIC TESTS — pattern O] These test files exercise env-gated auth/config without pinning mocks:\n` +
    files.map((file) => `  - ${file}`).join("\n") +
    `\nPin isClerkConfigured / publishable keys via vi.mock / vi.stubEnv so local env vars cannot flip CI-green suites red.\n` +
    `Set OPENCODE_ENV_HERMETIC_GUARD=off to silence.`
  )
}

export function scanEnvHermeticViolations(files: { file: string; text: string }[]) {
  return files.filter((item) => needsEnvHermeticMock(item.text)).map((item) => item.file)
}

export function envHermeticGuardDisabled(env: NodeJS.ProcessEnv = process.env) {
  return /^(0|false|off|no)$/i.test(env.OPENCODE_ENV_HERMETIC_GUARD ?? "")
}
