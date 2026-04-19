import { AppFileSystem } from "@opencode-ai/shared/filesystem"

export function canonicalizeWorkingDirectory(dir?: string) {
  if (dir) {
    process.chdir(dir)
  }
  const cwd = process.cwd()
  const resolved = AppFileSystem.resolve(cwd)
  if (resolved !== cwd) {
    process.chdir(resolved)
  }
  return resolved
}
