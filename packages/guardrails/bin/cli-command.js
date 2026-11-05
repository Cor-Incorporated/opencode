/** Explicit JavaScript CLI shims need an interpreter on Windows and need no executable bit on POSIX. */
export function cliCommand(binary, args) {
  return /\.(?:c|m)?js$/i.test(binary) ? [process.execPath, binary, ...args] : [binary, ...args]
}
