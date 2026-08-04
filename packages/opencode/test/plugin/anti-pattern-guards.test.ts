import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Permission } from "../../src/permission"
import { tmpdir } from "../fixture/fixture"
import {
  classifyCiTier,
  isDocsPath,
  shouldRunFullCi,
} from "../../../../packages/guardrails/profile/plugins/ci-change-scope"
import {
  countStaleBranches,
  countWorktrees,
  createHygieneHandlers,
  hygieneWarningMessage,
} from "../../../../packages/guardrails/profile/plugins/hygiene-warning"
import {
  createRemovalHandlers,
  findReverseReferences,
  isGitRemovalCommand,
  parseGitRmTargets,
  referenceNeedle,
  removalBlockMessage,
  removalGuardDisabled,
} from "../../../../packages/guardrails/profile/plugins/removal-guard"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import guardrail from "../../../../packages/guardrails/profile/plugins/guardrail"

const profileRoot = path.resolve(import.meta.dir, "../../../../packages/guardrails/profile")

async function context(worktree?: string) {
  const tmp = worktree ? { path: worktree, [Symbol.asyncDispose]: async () => {} } : await tmpdir()
  const state = path.join(tmp.path, ".opencode", "guardrails", "state.json")
  const marks: Record<string, unknown>[] = []
  const ctx: GuardrailContext = {
    input: {
      client: {} as GuardrailContext["input"]["client"],
      directory: tmp.path,
      worktree: tmp.path,
    },
    mode: "enforced",
    root: path.join(tmp.path, ".opencode", "guardrails"),
    log: path.join(tmp.path, ".opencode", "guardrails", "events.jsonl"),
    state,
    allow: {},
    hasCodexMcp: false,
    maxParallelTasks: 5,
    maxSessionCost: 10,
    agentModelTier: {},
    tierModels: {},
    domainDirs: {},
    async mark(data) {
      marks.push(data)
      await fs.mkdir(path.dirname(state), { recursive: true })
      await Bun.write(
        state,
        JSON.stringify(
          {
            ...(await Bun.file(state)
              .json()
              .catch(() => ({}))),
            ...data,
          },
          null,
          2,
        ),
      )
    },
    async seen() {},
    note() {
      return { sessionID: undefined, permission: undefined, patterns: undefined }
    },
    hidden() {
      return false
    },
    code() {
      return false
    },
    fact() {
      return false
    },
    stale() {
      return false
    },
    factLine() {
      return ""
    },
    reviewLine() {
      return ""
    },
    compact() {
      return ""
    },
    deny() {
      return undefined
    },
    baseline() {
      return undefined
    },
    async version() {
      return undefined
    },
    async budget() {
      return 0
    },
    gate() {
      return undefined
    },
  }
  return {
    ctx,
    marks,
    path: tmp.path,
    [Symbol.asyncDispose]: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function profileBashRuleset() {
  const config = Bun.file(path.join(profileRoot, "opencode.json")).json() as Promise<{
    permission: { bash: Record<string, "allow" | "ask" | "deny"> }
  }>
  return config.then((json) => Permission.fromConfig({ bash: json.permission.bash }))
}

function implementBashRuleset() {
  // Mirrors agents/implement.md bash block (pattern I symmetry fixture).
  // NOTE: "gh pr merge *" is intentionally absent — the default primary agent
  // must honor the config allow (issue #292). See loadAgentBashRuleset for the
  // real-file guard that prevents this fixture from drifting.
  return Permission.fromConfig({
    bash: {
      "*": "allow",
      "git worktree list*": "allow",
      "git merge-base *": "allow",
      "git status*": "allow",
      "git log*": "allow",
      "git worktree add *": "ask",
      "git branch -D *": "ask",
      "git checkout -- *": "deny",
      "git merge *": "deny",
      "git push --force*": "deny",
      "git push * --force*": "deny",
      "git reset --hard*": "deny",
      "rm -rf *": "deny",
      "rm -r *": "deny",
      "sudo *": "deny",
      "curl * | sh*": "deny",
      "wget * | sh*": "deny",
    },
  })
}

const previousRemoval = process.env.OPENCODE_REMOVAL_GUARD
const previousHygiene = process.env.OPENCODE_HYGIENE_GUARD

afterEach(() => {
  if (previousRemoval === undefined) delete process.env.OPENCODE_REMOVAL_GUARD
  else process.env.OPENCODE_REMOVAL_GUARD = previousRemoval
  if (previousHygiene === undefined) delete process.env.OPENCODE_HYGIENE_GUARD
  else process.env.OPENCODE_HYGIENE_GUARD = previousHygiene
})

describe("anti-pattern A — removal guard", () => {
  test("detects structural git rm / add -A, not unrelated words like high", () => {
    expect(isGitRemovalCommand("git rm src/foo.ts")).toBe(true)
    expect(isGitRemovalCommand("git add -A")).toBe(true)
    expect(isGitRemovalCommand("git status --short")).toBe(false)
    expect(isGitRemovalCommand("gh pr comment 1 --body 'severity severity note'")).toBe(false)
    expect(isGitRemovalCommand("echo delete high impact")).toBe(false)
  })

  test("blocks removal when reverse references exist (positive)", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.path).quiet()
    await Bun.$`git config user.name "Test"`.cwd(fixture.path).quiet()
    await Bun.write(path.join(fixture.path, "policy-ci.ts"), "export const policyCi = true\n")
    await Bun.write(path.join(fixture.path, "workflow.ts"), "import { policyCi } from './policy-ci'\n")
    await Bun.$`git add .`.cwd(fixture.path).quiet()
    await Bun.$`git commit -m init`.cwd(fixture.path).quiet()

    delete process.env.OPENCODE_REMOVAL_GUARD
    const removal = createRemovalHandlers(fixture.ctx)
    await expect(removal.bashBeforeRemoval("git rm policy-ci.ts")).rejects.toThrow("reverse references found")
  })

  test("falsify: disabling the guard lets referenced removal through", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.path).quiet()
    await Bun.$`git config user.name "Test"`.cwd(fixture.path).quiet()
    await Bun.write(path.join(fixture.path, "policy-ci.ts"), "export const policyCi = true\n")
    await Bun.write(path.join(fixture.path, "workflow.ts"), "import { policyCi } from './policy-ci'\n")
    await Bun.$`git add .`.cwd(fixture.path).quiet()
    await Bun.$`git commit -m init`.cwd(fixture.path).quiet()

    process.env.OPENCODE_REMOVAL_GUARD = "off"
    expect(removalGuardDisabled()).toBe(true)
    const removal = createRemovalHandlers(fixture.ctx)
    await expect(removal.bashBeforeRemoval("git rm policy-ci.ts")).resolves.toBeUndefined()
  })

  test("negative: safe git reads and high-word comments are not blocked", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    const removal = createRemovalHandlers(fixture.ctx)
    await expect(removal.bashBeforeRemoval("git status --short")).resolves.toBeUndefined()
    await expect(removal.bashBeforeRemoval("git log -1")).resolves.toBeUndefined()
    await expect(removal.bashBeforeRemoval("gh pr comment 1 --body high priority")).resolves.toBeUndefined()
  })

  test("negative: unreferenced deletion is allowed", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.path).quiet()
    await Bun.$`git config user.name "Test"`.cwd(fixture.path).quiet()
    await Bun.write(path.join(fixture.path, "orphan-only.ts"), "export const orphanOnly = 1\n")
    await Bun.write(path.join(fixture.path, "other.ts"), "export const other = 2\n")
    await Bun.$`git add .`.cwd(fixture.path).quiet()
    await Bun.$`git commit -m init`.cwd(fixture.path).quiet()

    const hits = await findReverseReferences(fixture.path, ["orphan-only.ts"])
    expect(removalBlockMessage(hits)).toBeUndefined()
    const removal = createRemovalHandlers(fixture.ctx)
    await expect(removal.bashBeforeRemoval("git rm orphan-only.ts")).resolves.toBeUndefined()
  })

  test("parseGitRmTargets and referenceNeedle are path/structure based", () => {
    expect(parseGitRmTargets(`git rm "src/a.ts" 'src/b.ts' -f`)).toEqual(["src/a.ts", "src/b.ts"])
    expect(referenceNeedle("packages/foo/policy-ci.yml")).toBe("policy-ci")
  })

  test("short filenames still catch ./stem imports without bare-letter overmatch", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.path).quiet()
    await Bun.$`git config user.name "Test"`.cwd(fixture.path).quiet()
    await Bun.write(path.join(fixture.path, "a.ts"), "export const aMarker = 1\n")
    await Bun.write(path.join(fixture.path, "b.ts"), 'import { aMarker } from "./a"\n')
    await Bun.write(path.join(fixture.path, "note.ts"), 'export const high = "unrelated word"\n')
    await Bun.$`git add .`.cwd(fixture.path).quiet()
    await Bun.$`git commit -m init`.cwd(fixture.path).quiet()

    const hits = await findReverseReferences(fixture.path, ["a.ts"])
    expect(hits.some((hit) => hit.target === "a.ts" && hit.refs.includes("b.ts"))).toBe(true)
    const removal = createRemovalHandlers(fixture.ctx)
    await expect(removal.bashBeforeRemoval("git rm a.ts")).rejects.toThrow("reverse references found")
    // note.ts mentioning "high" must not create a false removal block by itself
    await expect(removal.bashBeforeRemoval("git rm note.ts")).resolves.toBeUndefined()
  })
})

describe("anti-pattern B/I — permission symmetry and over-restriction proofs", () => {
  test("profile allows read git and denies force-push", async () => {
    const rules = await profileBashRuleset()
    expect(Permission.evaluate("bash", "git worktree list", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git merge-base HEAD origin/dev", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status --short", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git log -1", rules).action).toBe("allow")
    expect(Permission.evaluate("bash", "git push --force origin feature", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git worktree add ../tmp feature", rules).action).toBe("ask")
    expect(Permission.evaluate("bash", "git branch -D stale", rules).action).toBe("ask")
  })

  test("implement agent matches the same read/deny outcomes (symmetry)", async () => {
    const profile = await profileBashRuleset()
    const implement = implementBashRuleset()
    for (const cmd of ["git worktree list", "git merge-base a b", "git status", "git log -1"]) {
      expect(Permission.evaluate("bash", cmd, profile).action).toBe(Permission.evaluate("bash", cmd, implement).action)
      expect(Permission.evaluate("bash", cmd, implement).action).toBe("allow")
    }
    expect(Permission.evaluate("bash", "git push --force origin x", profile).action).toBe("deny")
    expect(Permission.evaluate("bash", "git push --force origin x", implement).action).toBe("deny")
  })

  test("word 'high' is not a permission pattern and does not deny", async () => {
    const rules = await profileBashRuleset()
    expect(Permission.evaluate("bash", "echo high severity review", rules).action).not.toBe("deny")
  })
})

// agent.ts builds a user-defined primary agent's permission as
//   merge(merge(defaults, userConfig), agentDefinition)
// and Permission.evaluate uses findLast, so the agent definition is applied
// AFTER the user config and overrides it. For the DEFAULT primary agent
// (implement, the main session agent), a deny in implement.md therefore
// overrides an explicit allow in opencode.json — the main session silently
// loses the ability the config grants (issue #292). These proofs read the real
// agent files so fixture drift cannot hide the regression again.
describe("anti-pattern I — primary-agent permission leak (issue #292)", () => {
  async function loadAgentBashRuleset(filename: string) {
    const matter = (await import("gray-matter")).default
    const file = await Bun.file(path.join(profileRoot, "agents", filename)).text()
    const parsed = matter(file)
    const bash = parsed.data?.permission?.bash ?? {}
    return Permission.fromConfig({ bash })
  }

  test("implement (default primary) effective permission allows gh pr merge per config", async () => {
    const configBash = await profileBashRuleset()
    const implementBash = await loadAgentBashRuleset("implement.md")
    // Faithful to agent.ts bash precedence: config first, agent definition last.
    const effective = Permission.merge(configBash, implementBash)
    expect(Permission.evaluate("bash", "gh pr merge 1777 --merge", effective).action).toBe("allow")
  })

  test("falsify: a primary-agent deny layered on a config allow is what blocks the main session", async () => {
    const configBash = await profileBashRuleset()
    const withLeak = Permission.merge(configBash, Permission.fromConfig({ bash: { "gh pr merge *": "deny" } }))
    // PROOF: when implement.md declares the deny, evaluate lands on deny and
    // overrides the config allow. This is the exact regression the test above
    // guards against — flip implement.md back to denying and it resurfaces.
    expect(Permission.evaluate("bash", "gh pr merge 1777 --merge", withLeak).action).toBe("deny")
  })

  test("negative: destructive ops the config also denies remain denied for implement", async () => {
    const configBash = await profileBashRuleset()
    const implementBash = await loadAgentBashRuleset("implement.md")
    const effective = Permission.merge(configBash, implementBash)
    expect(Permission.evaluate("bash", "rm -rf node_modules", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "git push --force origin feat", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "git reset --hard origin/dev", effective).action).toBe("deny")
  })

  test("specialized primary (planner) is read-only by design and may still self-restrict", async () => {
    // planner is a read-only primary agent; its gh pr merge deny is intentional
    // and not the #292 bug. Only the DEFAULT primary (implement) must honor an
    // explicit config allow, because that is the main session agent.
    const configBash = await profileBashRuleset()
    const plannerBash = await loadAgentBashRuleset("planner.md")
    const effective = Permission.merge(configBash, plannerBash)
    expect(Permission.evaluate("bash", "gh pr merge 1 --merge", effective).action).toBe("deny")
  })
})

describe("anti-pattern E — hygiene warning", () => {
  test("warns only above thresholds; below threshold is silent (negative)", () => {
    expect(countWorktrees("worktree /a\nHEAD abc\n\nworktree /b\nHEAD def\n")).toBe(2)
    expect(countStaleBranches(["* main", "  feat/a", "  feat/b"], "main", [])).toBe(2)
    expect(hygieneWarningMessage({ worktrees: 3, staleBranches: 2 })).toBeUndefined()
    expect(hygieneWarningMessage({ worktrees: 9, staleBranches: 0 })).toContain("worktrees=9")
    expect(hygieneWarningMessage({ worktrees: 1, staleBranches: 11 })).toContain("merged-local-branches=11")
    expect(hygieneWarningMessage({ worktrees: 9, staleBranches: 11 }, undefined)?.includes("high")).toBe(false)
  })

  test("falsify: disabling hygiene guard skips session warning mark", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    process.env.OPENCODE_HYGIENE_GUARD = "off"
    const hygiene = createHygieneHandlers(fixture.ctx, { worktrees: 0, staleBranches: 0 })
    await hygiene.onSessionCreated()
    expect(fixture.marks.some((mark) => typeof mark.hygiene_warning === "string" && mark.hygiene_warning.length > 0)).toBe(
      false,
    )
  })

  test("positive: low thresholds mark a hygiene warning on session create", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.path).quiet()
    await Bun.$`git commit --allow-empty -m root`.cwd(fixture.path).quiet()
    delete process.env.OPENCODE_HYGIENE_GUARD
    const hygiene = createHygieneHandlers(fixture.ctx, { worktrees: 0, staleBranches: 0 })
    await hygiene.onSessionCreated()
    const warning = fixture.marks.map((mark) => mark.hygiene_warning).find((value) => typeof value === "string" && value)
    expect(String(warning)).toContain("Repo hygiene")
  })
})

describe("anti-pattern J — CI change scope", () => {
  test("docs-only specs PR does not require full CI", () => {
    const files = ["specs/ai-guardrails-anti-patterns.md"]
    expect(files.every(isDocsPath)).toBe(true)
    expect(classifyCiTier(files)).toBe("docs")
    expect(shouldRunFullCi(files)).toBe(false)
  })

  test("guardrails changes stay on full CI even when markdown", () => {
    const files = ["packages/guardrails/profile/commands/plan-light.md"]
    expect(classifyCiTier(files)).toBe("guardrails")
    expect(shouldRunFullCi(files)).toBe(true)
  })

  test("code changes require full CI", () => {
    expect(classifyCiTier(["packages/opencode/src/index.ts"])).toBe("code")
    expect(shouldRunFullCi(["packages/opencode/src/index.ts"])).toBe(true)
  })

  test("workflow path filters encode the same docs skip policy", async () => {
    const testYml = await Bun.file(path.resolve(import.meta.dir, "../../../../.github/workflows/test.yml")).text()
    expect(testYml).toContain("!specs/**")
    expect(testYml).toContain("packages/guardrails/**")
    const docsYml = await Bun.file(path.resolve(import.meta.dir, "../../../../.github/workflows/docs-lint.yml")).text()
    expect(docsYml).toContain("docs-lint")
    expect(docsYml).toContain("specs/**")
  })
})

describe("anti-pattern C/D/E/F/G/H — command and skill assets", () => {
  test("commands and skills exist with required guidance (wiring)", async () => {
    const commands = ["plan-light.md", "env-check.md", "repo-hygiene.md"]
    for (const name of commands) {
      const body = await Bun.file(path.join(profileRoot, "commands", name)).text()
      expect(body.length).toBeGreaterThan(40)
      expect(body).toContain("---")
    }
    const plan = await Bun.file(path.join(profileRoot, "commands", "plan-light.md")).text()
    expect(plan).toContain("fake/failing test")
    expect(plan.toLowerCase()).toContain("minimal")

    const env = await Bun.file(path.join(profileRoot, "commands", "env-check.md")).text()
    expect(env.toLowerCase()).toContain("last resort")

    const hygiene = await Bun.file(path.join(profileRoot, "commands", "repo-hygiene.md")).text()
    expect(hygiene.toLowerCase()).toContain("dry-run")

    for (const skill of ["falsifiable-change", "lean-pipeline", "self-check", "impact-analysis"]) {
      const body = await Bun.file(path.join(profileRoot, "skills", skill, "SKILL.md")).text()
      expect(body).toContain(`name: ${skill}`)
      expect(body).toContain("description:")
    }
  })
})

describe("aggregate guardrail wiring", () => {
  test("removal guard runs through aggregate tool.execute.before", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "policy-ci.ts"), "export const policyCi = true\n")
    await Bun.write(path.join(tmp.path, "workflow.ts"), "import { policyCi } from './policy-ci'\n")
    await Bun.$`git add .`.cwd(tmp.path).quiet()
    await Bun.$`git commit -m init`.cwd(tmp.path).quiet()

    delete process.env.OPENCODE_REMOVAL_GUARD
    const plugin = await guardrail(
      {
        client: {
          session: {
            async create() {
              return { data: { id: "unused" } }
            },
            async promptAsync() {
              return {}
            },
            async prompt() {
              return {}
            },
            async status() {
              return { data: {} }
            },
            async messages() {
              return { data: [] }
            },
            async abort() {
              return {}
            },
          },
        },
        directory: tmp.path,
        worktree: tmp.path,
      },
      {},
    )
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_rm" } } })
    await expect(
      plugin["tool.execute.before"](
        { tool: "bash", args: { command: "git rm policy-ci.ts" } },
        { args: { command: "git rm policy-ci.ts" } },
      ),
    ).rejects.toThrow("reverse references found")
  })
})
