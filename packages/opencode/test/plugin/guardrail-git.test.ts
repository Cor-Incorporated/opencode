import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { createGitHandlers } from "../../../../packages/guardrails/profile/plugins/guardrail-git"
import type { GuardrailContext } from "../../../../packages/guardrails/profile/plugins/guardrail-context"
import { tmpdir } from "../fixture/fixture"

async function context() {
  const tmp = await tmpdir()
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
    [Symbol.asyncDispose]: async () => {
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function opencodeFixture() {
  const fixture = await context()
  await Bun.$`git init`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config core.fsmonitor false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config commit.gpgsign false`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git config user.name "Test"`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git commit --allow-empty -m root`.cwd(fixture.ctx.input.worktree).quiet()
  await Bun.$`git remote add origin git@github.com:Cor-Incorporated/opencode.git`
    .cwd(fixture.ctx.input.worktree)
    .quiet()
  return fixture
}

describe("guardrail-git", () => {
  test("blocks direct pushes to protected branches", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx)

    await expect(git.bashBeforeGit("git push origin dev", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
    await expect(git.bashBeforeGit("git push origin main", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
    await expect(git.bashBeforeGit("git push origin develop", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
    await expect(git.bashBeforeGit("git push origin master", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
  })

  test("blocks HEAD:branch refspec pushes to protected branches", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx)

    await expect(git.bashBeforeGit("git push origin HEAD:main", {}, {})).rejects.toThrow(
      "direct push to protected branch blocked",
    )
  })

  test("allows pushes to non-protected branches", async () => {
    await using fixture = await context()
    const git = createGitHandlers(fixture.ctx)

    await expect(git.bashBeforeGit("git push origin feat/policy", {}, {})).resolves.toBeUndefined()
    await expect(git.bashBeforeGit("git push -u origin feat/policy", {}, {})).resolves.toBeUndefined()
  })

  test("blocks own-approval of a PR via gh pr review --approve", async () => {
    await using fixture = await context()
    const original = Bun.spawn
    Bun.spawn = ((command: string[] | { cmd: string[] }, options?: object) => {
      const args = Array.isArray(command) ? command.map(String) : command.cmd.map(String)
      if (args[0] !== "gh") {
        return Reflect.apply(original, Bun, options === undefined ? [command] : [command, options]) as ReturnType<
          typeof Bun.spawn
        >
      }
      if (args[1] === "pr" && args[2] === "view") {
        return {
          stdout: new Response(JSON.stringify({ number: 42, author: { login: "octocat" } })).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
          exitCode: 0,
        } as ReturnType<typeof Bun.spawn>
      }
      if (args[1] === "api" && args[2] === "user") {
        return {
          stdout: new Response("octocat\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
          exitCode: 0,
        } as ReturnType<typeof Bun.spawn>
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        exitCode: 0,
      } as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn
    try {
      const git = createGitHandlers(fixture.ctx)
      await expect(git.bashBeforeGit("gh pr review 42 --approve", {}, {})).rejects.toThrow(
        "cannot approve your own PR",
      )
    } finally {
      Bun.spawn = original
    }
  })

  test("allows approving a PR authored by someone else", async () => {
    await using fixture = await context()
    const original = Bun.spawn
    Bun.spawn = ((command: string[] | { cmd: string[] }, options?: object) => {
      const args = Array.isArray(command) ? command.map(String) : command.cmd.map(String)
      if (args[0] !== "gh") {
        return Reflect.apply(original, Bun, options === undefined ? [command] : [command, options]) as ReturnType<
          typeof Bun.spawn
        >
      }
      if (args[1] === "pr" && args[2] === "view") {
        return {
          stdout: new Response(JSON.stringify({ number: 42, author: { login: "someone-else" } })).body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
          exitCode: 0,
        } as ReturnType<typeof Bun.spawn>
      }
      if (args[1] === "api" && args[2] === "user") {
        return {
          stdout: new Response("octocat\n").body!,
          stderr: new Response("").body!,
          exited: Promise.resolve(0),
          exitCode: 0,
        } as ReturnType<typeof Bun.spawn>
      }
      return {
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        exitCode: 0,
      } as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn
    try {
      const git = createGitHandlers(fixture.ctx)
      await expect(git.bashBeforeGit("gh pr review 42 --approve", {}, {})).resolves.toBeUndefined()
    } finally {
      Bun.spawn = original
    }
  })

  test("blocks opencode PR creation unless it targets fork dev", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx)

    await expect(
      git.bashBeforeGit(
        "gh pr create --repo=anomalyco/opencode --base=dev --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -RCor-Incorporated/opencode --base=main --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head=anomalyco:feature --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head=other-owner:feature --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).rejects.toThrow("opencode PR creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh pr create -R Cor-Incorporated/opencode -B dev --head feature --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls --method GET&&gh pr create -R anomalyco/opencode -B dev --title 'fix: guard' --body 'Closes #1'",
        {},
        {},
      ),
    ).rejects.toThrow("opencode PR creation blocked")
  })

  test("blocks opencode GitHub API PR creation bypasses", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx)

    await expect(
      git.bashBeforeGit(
        "gh api https://api.github.com/repos/anomalyco/opencode/pulls -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/anomalyco/opencode/pulls/ -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api /repos/Cor-Incorporated/opencode/pulls -F title='fix: guard' -F head=feature -F base=main",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls --raw-field title='fix: guard' --field head=anomalyco:feature --field base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit("gh api repos/Cor-Incorporated/opencode/pulls --input payload.json", {}, {}),
    ).rejects.toThrow("REST pull request creation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api repos/Cor-Incorporated/opencode/pulls -f title='fix: guard' -f head=feature -f base=dev",
        {},
        {},
      ),
    ).rejects.toThrow("REST pull request creation blocked")
  })

  test("allows read-only opencode GitHub API PR listing", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx)

    await expect(
      git.bashBeforeGit("gh api repos/anomalyco/opencode/pulls --method GET", {}, {}),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit("gh api repos/anomalyco/opencode/pulls --method GET --input payload.json", {}, {}),
    ).resolves.toBeUndefined()
  })

  test("blocks opencode GraphQL createPullRequest mutations", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx)
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "create-pr.graphql"),
      'mutation Create { createPullRequest(input: { repositoryId: "repo", baseRefName: "main", headRefName: "feature", title: "x" }) { pullRequest { number } } }',
    )
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "create-pr.json"),
      '{"query":"mutation Create { createPullRequest(input: { repositoryId: \\"repo\\" }) { clientMutationId } }"}',
    )

    await expect(
      git.bashBeforeGit(
        "gh api https://api.github.com/graphql/ -f query='mutation { createPullRequest(input: { repositoryId: \"repo\" }) { pullRequest { number } } }'",
        {},
        {},
      ),
    ).rejects.toThrow("GraphQL createPullRequest mutation blocked")

    await expect(
      git.bashBeforeGit(
        "gh api graphql --method POST --field query='mutation Create { createPullRequest(input: { repositoryId: \"repo\" }) { clientMutationId } }'",
        {},
        {},
      ),
    ).rejects.toThrow("GraphQL createPullRequest mutation blocked")

    await expect(git.bashBeforeGit("gh api graphql -F query=@create-pr.graphql", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql --input create-pr.json", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql -F query=@-", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit("gh api graphql -f query=$QUERY", {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )

    await expect(git.bashBeforeGit('gh api graphql -f query="$(cat create-pr.graphql)"', {}, {})).rejects.toThrow(
      "GraphQL createPullRequest mutation blocked",
    )
  })

  test("allows read-only opencode GraphQL queries", async () => {
    await using fixture = await opencodeFixture()
    const git = createGitHandlers(fixture.ctx)
    await Bun.write(path.join(fixture.ctx.input.worktree, "viewer.graphql"), "query Viewer { viewer { login } }")
    await Bun.write(
      path.join(fixture.ctx.input.worktree, "viewer.json"),
      '{"query":"query Viewer { viewer { login } }"}',
    )

    await expect(
      git.bashBeforeGit("gh api graphql -f query='query Viewer { viewer { login } }'", {}, {}),
    ).resolves.toBeUndefined()

    await expect(
      git.bashBeforeGit(
        "gh api graphql -f query='query Viewer($login: String!) { user(login: $login) { id } }'",
        {},
        {},
      ),
    ).resolves.toBeUndefined()

    await expect(git.bashBeforeGit("gh api graphql -F query=@viewer.graphql", {}, {})).resolves.toBeUndefined()

    await expect(git.bashBeforeGit("gh api graphql --input viewer.json", {}, {})).resolves.toBeUndefined()
  })

  test("does not gate non-opencode worktrees on PR target", async () => {
    await using fixture = await context()
    await Bun.$`git init`.cwd(fixture.ctx.input.worktree).quiet()
    await Bun.$`git config commit.gpgsign false`.cwd(fixture.ctx.input.worktree).quiet()
    await Bun.$`git config user.email "test@opencode.test"`.cwd(fixture.ctx.input.worktree).quiet()
    await Bun.$`git config user.name "Test"`.cwd(fixture.ctx.input.worktree).quiet()
    await Bun.$`git commit --allow-empty -m root`.cwd(fixture.ctx.input.worktree).quiet()
    await Bun.$`git remote add origin git@github.com:some-org/unrelated-repo.git`
      .cwd(fixture.ctx.input.worktree)
      .quiet()
    const git = createGitHandlers(fixture.ctx)

    await expect(
      git.bashBeforeGit("gh pr create --repo=anomalyco/opencode --base=dev --title 'fix: guard'", {}, {}),
    ).resolves.toBeUndefined()
  })
})
