import { homedir } from "os"
import path from "path"
import type { GuardrailContext } from "./guardrail-context"
import { bash } from "./guardrail-patterns"

/**
 * Additive shell checks for the plugin-owned runtime (opencode#349). guardrail-access.ts keeps the workdir and text
 * checks it had before and ORs these on top, so they can only add a block, never remove one (#350 review).
 *
 * A shell can change or name its directory in more ways than this can parse (`builtin cd`, `\cd`, `X=1 cd`, `( cd … )`,
 * `if cd …`, `cd -`, `popd`, CDPATH, `git -C`, `$(…)`), so it does not track which `cd` runs. When the command could
 * change directory at all, every path token is a candidate base, combined up to three deep, together with the workdir
 * and the home dir. The command reaches the runtime when any candidate base, or any token resolved at one, is a runtime
 * dir or lies inside one. Without a directory change only a path strictly inside the runtime counts, plus a glob that
 * can match it, plus a dir-target writer (cp, mv, rm, tar, find -delete, …) naming the runtime or its parent: the bare
 * dir under `mkdir -p`, `git check-ignore` or `echo … >> .gitignore` is not a mutation. Quoted text with spaces is
 * prose except under eval, `sh -c` and inline interpreters, whose quoted code is read as tokens too.
 */
export function shellReachesRuntime(rt: Runtime, cmd: string, workdir: string) {
  const expanded = expand(cmd)
  const code = /(?:^|[\s;&|(])(?:eval|(?:sh|bash|zsh)\s+-c|(?:python3?|ruby|perl|node|bun|deno)\s+(?:-\w*[ce]\b|--eval\b|eval\b))/i.test(prose(expanded))
  const text = code ? expanded : prose(expanded)
  const tokens = text
    .split(/[\s;&|(){}<>`'",=]+|\$\(/)
    .map((token) => token.replace(/\\/g, ""))
    .filter((token) => token !== "" && !token.startsWith("-"))
  const start = path.resolve(rt.input.directory, workdir)
  // globs are compared case-folded where the filesystem folds case, or where the command could tell the shell to
  // ignore case (shopt / setopt / BASHOPTS, also when split by quotes or built by eval, $(…), ${…}); on a
  // case-keeping filesystem a plain `GUARD*` cannot reach `guardrails` (#350 review)
  const fold = rt.foldsCase || /shopt|setopt|bashopts|case_?glob|\beval\b|\$[({]|`/i.test(cmd.replace(/["'\\]/g, ""))
  if (writes(rt, text, start)) return true
  if (tokens.some((token) => rt.hidden(path.resolve(start, token)) || glob(rt, path.resolve(start, token), fold))) return true
  if (!moves(text)) return false
  const bases = candidates(start, tokens)
  return bases.some((base) => rt.runtime(base) || tokens.some((token) => rt.runtime(path.resolve(base, token)) || glob(rt, path.resolve(base, token), fold)))
}

/** Read-only only when no segment writes: every segment is a cd or a listed reader, and nothing is redirected. */
export function shellReadOnly(cmd: string) {
  if (bash(cmd)) return false
  if (/\bsed\b.*['"\s;{}/][wW]\s+\S/.test(cmd)) return false // sed's `w file` command writes
  const text = prose(cmd)
  if (/>(?!\s*(?:&\d|\/dev\/null\b))/.test(text.replace(/\d>&\d/g, ""))) return false
  // a `|`, `;` or `{` inside quotes is an argument (`grep -E 'a|b'`, `sed -n '/x/{p;}'`), not a separator (#350
  // review). Only text the shell keeps literal is masked: double quotes with $, ` or \ still expand (`"${1:--delete}"`).
  const literal = (quoted: string) => quoted.startsWith("'") || !/[$`\\]/.test(quoted)
  const masked = text.replace(/"[^"]*"|'[^']*'/g, (quoted) => (literal(quoted) && /[|;&\n(){}]/.test(quoted) ? "q" : quoted))
  return segments(masked).every((segment) => {
    const name = command(segment)
    if (name === "find") return !/\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b/.test(segment)
    if (name === "sed") return /\s-n\b/.test(segment)
    return /^(?:|cd|pushd|popd|ls|cat|grep|egrep|fgrep|rg|pwd|stat|wc|head|tail|test|\[|readlink|file|du|true|:|fi|done|esac)$/.test(name)
  })
}

type Runtime = Pick<GuardrailContext, "input" | "runtime" | "hidden" | "runtimes" | "foldsCase">

/** A dir-target writer naming the runtime, something inside it, or the dir that holds it. */
function writes(rt: Runtime, text: string, base: string) {
  return segments(text).some((segment) => {
    const name = command(segment)
    const writer = /^(?:cp|mv|rm|rmdir|rsync|install|ln|ditto|tar|unzip|chmod|chown)$/.test(name)
    if (!writer && !(name === "find" && /\s-(?:delete|exec|execdir|ok|okdir)\b/.test(segment))) return false
    return segment
      .split(/\s+/)
      .filter((token) => token !== "" && !token.startsWith("-"))
      .some((token) => rt.runtime(path.resolve(base, token)) || rt.runtime(path.resolve(base, token, "guardrails")))
  })
}

/** `.opencode/guard*` style globs: true when a leading part of the pattern can match a runtime dir. */
function glob(rt: Runtime, file: string, fold: boolean) {
  if (!/[*?[]/.test(file)) return false
  const parts = file.split("/")
  return parts.some((_, i) => {
    const prefix = parts.slice(0, i + 1).join("/")
    const cased = (text: string) => (fold ? text.toLowerCase() : text)
    return /[*?[]/.test(prefix) && rt.runtimes.some((dir) => new Bun.Glob(cased(prefix)).match(cased(dir)))
  })
}

/** The workdir, home and every token resolved at every base found so far, three rounds deep (CDPATH, nested cd). */
function candidates(start: string, tokens: string[]) {
  const seen = new Set([start, homedir()])
  for (const _ of [1, 2, 3]) {
    for (const base of [...seen]) {
      for (const token of tokens) {
        if (seen.size >= 512) return [...seen]
        seen.add(path.resolve(base, token))
      }
    }
  }
  return [...seen]
}

/** true when the command could change its directory or run something in another one. */
function moves(text: string) {
  return /(?:^|[^\w.\/-])(?:cd|pushd|popd)(?![\w.-])|\bCDPATH\b|\$\(|`|(?:^|\s)(?:-C|--directory|--git-dir|--work-tree)(?:[\s=]|$)/i.test(text)
}

/** `$NAME` / `${NAME}` replaced with the value assigned in the same command (`D=x; … $D/…`). */
function expand(cmd: string) {
  const vars = new Map([...cmd.matchAll(/(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=([^\s;&|)]*)/g)].map((m) => [m[1], m[2]]))
  return cmd.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)
}

/** Quoted text with spaces (commit messages, PR bodies) is prose; quotes pair left to right. */
function prose(cmd: string) {
  return cmd.replace(/"[^"]*"|'[^']*'/g, (quoted) => (/\s/.test(quoted) ? " " : quoted))
}

function segments(text: string) {
  return text.split(/&&|\|\||[;|&\n(){}]|\b(?:then|else|elif|do)\b/)
}

/** The command a segment runs, after assignments and wrappers: `FOO=1 builtin \cd` → `cd`, `/bin/CP` → `cp`. */
function command(segment: string) {
  const skip = /^(?:[A-Za-z_]\w*=\S*|builtin|command|sudo|env|exec|nohup|time|export|if|while|until|!)$/
  const word = segment.trim().split(/\s+/).map((w) => w.replace(/['"\\]/g, "")).find((w) => w !== "" && !skip.test(w)) ?? ""
  return path.basename(word).toLowerCase()
}
