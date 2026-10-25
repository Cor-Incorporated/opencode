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
  if (writes(rt, text, start)) return true
  if (tokens.some((token) => rt.hidden(path.resolve(start, token)) || glob(rt, path.resolve(start, token)))) return true
  if (!moves(text)) return false
  const bases = candidates(start, tokens)
  return bases.some((base) => rt.runtime(base) || tokens.some((token) => rt.runtime(path.resolve(base, token)) || glob(rt, path.resolve(base, token))))
}

/** Read-only only when no segment writes: every segment is a cd or a listed reader, and nothing is redirected. */
export function shellReadOnly(cmd: string) {
  if (bash(cmd)) return false
  if (/\bsed\b.*['"\s;{}/][wW]\s+\S/.test(cmd)) return false // sed's `w file` command writes
  const text = prose(cmd)
  if (/>(?!\s*(?:&\d|\/dev\/null\b))/.test(text.replace(/\d>&\d/g, ""))) return false
  // sed is judged on the raw segment (its quoted script intact): prose() would drop `'/review state/p'` and leave the
  // path in the script's place (Codex review of #353 round 3, P2). Segments are cut outside quotes only.
  return rawSegments(cmd).every((raw) => {
    const segment = prose(raw)
    const name = command(segment)
    if (name === "find") return !/\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b/.test(segment)
    if (name === "sed") return sedReadOnly(raw)
    return /^(?:|cd|pushd|popd|ls|cat|grep|egrep|fgrep|rg|pwd|stat|wc|head|tail|test|\[|readlink|file|du|true|:|fi|done|esac)$/.test(name)
  })
}

/**
 * The ONE shape of sed accepted as a read of the runtime (opencode#353 round 3, owner decision (A) 2026-10-24): the
 * segment is exactly `sed -n [-E|-r] <script> <path>…` where the script is single-quoted or a bare word, every path
 * is a bare word, and nothing in the segment can hide an option: no `\`, `$`, `"`, backtick, `#`, `--`, `;`, `&`,
 * `|`, `<`, `>` or parentheses. Rounds 1 and 2 enumerated the shapes that spell `-i` (escapes, ANSI-C quotes, GNU
 * prefixes) and the acceptance (aidd-governance#218, #219) found five more each time, so the allowance is now
 * positive and narrow; every other sed is a write. Scripts that run or write (`e`, `w`, `W`, `r`, `R`, the `e` / `w`
 * flags of `s`) are not reads either. Workaround for an honest read that this refuses: single-quote the script.
 */
export function sedReadOnly(segment: string) {
  if (/[\\$"`#;&|<>()]|--/.test(segment)) return false
  const words = segment.trim().match(/'[^']*'|\S+/g) ?? []
  if (!/^(?:\/[\w./-]*\/)?g?sed$/.test(words[0] ?? "")) return false
  let i = 1
  const opts = new Set<string>()
  while (i < words.length && /^-[nEr]$/.test(words[i])) opts.add(words[i++])
  if (!opts.has("-n")) return false
  const script = words[i++]
  if (script === undefined) return false
  const body = /^'[^']*'$/.test(script) ? script.slice(1, -1) : /^[\w,;/^.*+?=!{}\[\]]+$/.test(script) ? script : null
  // after quote removal sed sees the word itself: a leading `-` is another option (`'-f' program.sed` ran a file)
  if (body === null || body.startsWith("-") || !sedScriptReads(body)) return false
  return words.slice(i).every((w) => /^[\w./~+][\w./~+-]*$/.test(w))
}

/**
 * A sed script that only reads: every command, after its optional address(es) and `!`, is one of the print / hold /
 * branch / control commands, `y`, or an `s` whose flags carry no `w` or `e`, with any delimiter. Anything else (the
 * `w` / `W` / `r` / `R` / `e` commands, `s///w file`, `s///e`, an address or delimiter this does not parse) is not a
 * read (Codex review of round 3: `'1w file'` and `s:a:b:w file` had slipped past a `/`-only flag check).
 */
function sedScriptReads(script: string) {
  const addr = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)[IM]*`
  const prefix = new RegExp(String.raw`^\s*(?:${addr}(?:\s*[,~+]\s*(?:${addr}|\d+))?\s*)?!?\s*`)
  let rest = script
  for (let guard = 0; guard < 256 && rest.trim() !== ""; guard++) {
    rest = rest.slice((prefix.exec(rest) ?? [""])[0].length)
    const c = rest[0]
    if (c === undefined) return true
    if ("pPlnNdDhHgGxqQ={}".includes(c)) rest = rest.slice(1)
    else if ("btT:".includes(c)) rest = rest.replace(/^.[^;\n]*/, "")
    else if (c === "s" || c === "y") {
      const d = rest[1]
      if (d === undefined || /[\s\\\n\w]/.test(d)) return false
      const lit = d.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&")
      const part = String.raw`(?:[^\\${lit}]|\\.)*`
      const m = new RegExp(String.raw`^${c}${lit}${part}${lit}${part}${lit}([gpIimM0-9]*)`).exec(rest)
      if (!m) return false
      rest = rest.slice(m[0].length)
    } else return false
    rest = rest.replace(/^\s*(?:;\s*|\n\s*)*/, "")
  }
  return rest.trim() === ""
}

type Runtime = Pick<GuardrailContext, "input" | "runtime" | "hidden" | "runtimes">

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
function glob(rt: Runtime, file: string) {
  if (!/[*?[]/.test(file)) return false
  const parts = file.split("/")
  return parts.some((_, i) => {
    const prefix = parts.slice(0, i + 1).join("/")
    return /[*?[]/.test(prefix) && rt.runtimes.some((dir) => new Bun.Glob(prefix.toLowerCase()).match(dir.toLowerCase()))
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

/**
 * The command's segments, cut at unquoted `;`, `|`, `&`, `(`, `)`, `{`, `}`, newline and the then / else / elif / do
 * words. Inside double quotes `$(…)` and backticks still run (Codex review: `cat x"$(find … -delete)"` hid a find),
 * so they cut a segment too; a keyword inside quotes does not (`sed -n '/do work/p'` is one segment).
 */
function rawSegments(cmd: string) {
  const out: string[] = []
  let cur = ""
  let quote = ""
  let subshell = 0
  const cut = () => {
    out.push(cur)
    cur = ""
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote === "'") {
      if (ch === "'") quote = ""
      cur += ch
    } else if (ch === "\\" && cmd[i + 1] === "\n") {
      i++ // a line continuation vanishes before the shell reads the word (Codex review: `-de\<newline>lete` hid -delete)
    } else if (quote === '"') {
      // only a `$(` and the `)` that closes it cut the segment; a plain `)` in quoted text (`"(a|b)"`) is text
      if (ch === "\\") cur += ch + (cmd[++i] ?? "")
      else if (ch === "$" && cmd[i + 1] === "(") (cut(), i++, subshell++)
      else if (ch === ")" && subshell > 0) (cut(), subshell--)
      else if (ch === "`") cut()
      else {
        if (ch === '"') quote = ""
        cur += ch
      }
    } else if (ch === "\\") cur += ch + (cmd[++i] ?? "")
    else if (/[;|&(){}\n`]/.test(ch)) cut()
    else if (/\W/.test(cmd[i - 1] ?? " ") && /^(?:then|else|elif|do)\b/.test(cmd.slice(i))) {
      cut()
      i += /^(?:then|else|elif|do)/.exec(cmd.slice(i))![0].length - 1
    } else {
      if (ch === "'" || ch === '"') quote = ch
      cur += ch
    }
  }
  cut()
  return out
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
