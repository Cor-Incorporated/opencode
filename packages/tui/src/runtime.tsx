import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const pathImpl = isWindowsPath(input) || isWindowsPath(home) ? path.win32 : path.posix
  const relative = pathImpl.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + pathImpl.sep) || pathImpl.isAbsolute(relative)) return input
  return "~" + pathImpl.sep + relative
}

function isWindowsPath(input: string) {
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.includes("\\")
}
