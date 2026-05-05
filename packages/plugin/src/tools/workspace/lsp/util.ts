/**
 * Shared LSP helper utilities.
 *
 * Centralised so the four tool entry points (diagnostics, definition,
 * references, rename) do not redefine the same `friendlyError` heuristic.
 */

/**
 * Translate a raw LSP error into a human-friendly string.
 *
 * When the underlying spawn fails with `ENOENT` (binary missing) we surface
 * the install hint registered for the language; otherwise we forward the
 * original error message verbatim.
 */
export function friendlyError(err: unknown, installHint: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOENT|not found|spawn .* ENOENT/i.test(msg)) return installHint
  return msg
}
