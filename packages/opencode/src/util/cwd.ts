import { realpathSync } from "fs"

export function canonicalizeWorkingDirectory(dir?: string) {
  if (dir) {
    process.chdir(dir)
  }
  const cwd = process.cwd()
  const resolved = realpathSync.native(cwd)
  if (resolved !== cwd) {
    process.chdir(resolved)
  }
  return resolved
}
