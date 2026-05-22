import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { randomBytes } from "node:crypto"
import {
  GithubAuthError,
  normalizeGitOriginToHttps,
  resolveGithubToken,
  verifyGithubRepoAccess,
} from "./auth/github.js"
import { verifyVercelOidc } from "./auth/vercel.js"
import type { Context, WorkspaceExtra } from "./types.js"

const OPENCODE_PORT = 4096

export async function runConfigure(ctx: Context, info: WorkspaceInfo): Promise<WorkspaceInfo> {
  await ctx.log("info", "configure: starting preflight", {
    workspaceId: info.id,
    serverUrl: String(ctx.input.serverUrl),
  })

  await verifyVercelOidc()

  const git = await readHostGit(ctx)
  const includeUncommitted = decideUncommittedHandling(ctx, git)

  const remote = normalizeGitOriginToHttps(git.originUrl)
  if (remote.host !== "github.com") {
    throw new GithubAuthError(
      `Only github.com remotes are supported in v1; got "${remote.host}". Configured remote: ${git.originUrl}`,
    )
  }

  const token = await resolveGithubToken({ $: ctx.input.$, githubToken: ctx.options.githubToken })
  await verifyGithubRepoAccess(token, remote.owner, remote.repo)

  const opencodeVersion = ctx.options.opencodeVersion ?? (await fetchHostOpencodeVersion(ctx))

  const extra: WorkspaceExtra = {
    sandboxName: makeSandboxName(info.name, info.id),
    serverPassword: randomBytes(32).toString("base64url"),
    port: OPENCODE_PORT,
    gitUrl: remote.httpsUrl,
    gitRef: git.branch,
    opencodeVersion,
    ...(includeUncommitted ? { includeUncommitted: true } : {}),
  }

  await ctx.log("info", "configure: preflight ok", {
    workspaceId: info.id,
    branch: git.branch,
    repo: `${remote.owner}/${remote.repo}`,
    opencodeVersion,
    sandboxName: extra.sandboxName,
    includeUncommitted: extra.includeUncommitted ?? false,
  })

  return {
    ...info,
    branch: git.branch,
    directory: null,
    extra,
  }
}

type HostGit = {
  originUrl: string
  branch: string
  dirty: boolean
}

async function readHostGit(ctx: Context): Promise<HostGit> {
  const sh = ctx.input.$.cwd(ctx.input.worktree)

  // Distinguish "not a git repo at all" from "git repo with no origin" so
  // the user gets actionable guidance instead of a misleading "no origin"
  // error when there's actually no .git/ directory.
  //
  // In practice this branch shouldn't fire — opencode's own
  // `/experimental/worktree` endpoint refuses non-git projects with
  // `WorktreeNotGitError` before our `configure()` is ever called (see
  // `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1062`). We keep the check
  // as a defence-in-depth and to surface a clearer message if opencode
  // ever changes that contract.
  const insideRes = await sh`git rev-parse --is-inside-work-tree`.nothrow().quiet()
  if (insideRes.exitCode !== 0) {
    throw new Error(
      `configure: ${ctx.input.worktree} is not a git repository. ` +
        `This plugin requires a git-cloneable project. Run \`git init\` and \`git remote add origin <url>\` first.`,
    )
  }

  const originRes = await sh`git config --get remote.origin.url`.nothrow().quiet()
  if (originRes.exitCode !== 0) {
    throw new Error(
      "configure: no `origin` remote configured. Run `git remote add origin <url>` and push the current branch.",
    )
  }
  const originUrl = originRes.stdout.toString("utf8").trim()
  if (!originUrl) throw new Error("configure: `origin` remote URL is empty")

  const branchRes = await sh`git rev-parse --abbrev-ref HEAD`.nothrow().quiet()
  if (branchRes.exitCode !== 0) throw new Error("configure: failed to read current git branch")
  const branch = branchRes.stdout.toString("utf8").trim()
  if (!branch || branch === "HEAD") {
    throw new Error("configure: detached HEAD is not supported. Check out a named branch first.")
  }

  // Require an upstream tracking ref so we know the branch exists on origin
  // and the sandbox's `git clone --branch <branch>` will succeed.
  const upstreamRef = `${branch}@{upstream}`
  const upstreamRes = await sh`git rev-parse --abbrev-ref ${upstreamRef}`.nothrow().quiet()
  if (upstreamRes.exitCode !== 0) {
    throw new Error(
      `configure: branch "${branch}" has no upstream. Push it first with \`git push -u origin ${branch}\`, or switch to a tracked branch.`,
    )
  }

  const statusRes = await sh`git status --porcelain`.nothrow().quiet()
  if (statusRes.exitCode !== 0) throw new Error("configure: failed to read git status")
  const dirty = statusRes.stdout.toString("utf8").trim().length > 0

  return { originUrl, branch, dirty }
}

/**
 * Returns `true` when `create()` should overlay the host's working-tree
 * changes onto the sandbox after the initial clone (the `"include"` policy
 * on a dirty tree). Returns `false` for clean trees and the `"ignore"`
 * policy. Throws for `"refuse"` on a dirty tree.
 */
function decideUncommittedHandling(ctx: Context, git: HostGit): boolean {
  if (!git.dirty) return false
  if (ctx.options.uncommitted === "ignore") return false
  if (ctx.options.uncommitted === "include") return true
  throw new Error(
    `configure: working tree on branch "${git.branch}" has uncommitted changes. ` +
      `Commit/stash them, set \`uncommitted: "ignore"\` to clone clean from origin, ` +
      `or set \`uncommitted: "include"\` to overlay the working-tree changes onto the sandbox.`,
  )
}

async function fetchHostOpencodeVersion(ctx: Context): Promise<string> {
  // We can't rely on raw fetch(ctx.input.serverUrl): in TUI mode the server
  // isn't bound to a TCP port at all (the TUI talks to it in-process), and
  // `serverUrl` falls back to a literal "http://localhost:4096" that nothing
  // is listening on. The PluginInput `client` is configured by opencode with
  // a `fetch` override that calls `Server.Default().app.fetch(request)`
  // directly, so going through `client._client.get(...)` works in both TUI
  // and `opencode serve` modes.
  type LowLevelClient = {
    get: (opts: { url: string; throwOnError?: boolean }) => Promise<{
      data?: unknown
      error?: unknown
      response?: Response
    }>
  }
  const lowLevel = (ctx.input.client as unknown as { app: { _client: LowLevelClient } }).app._client
  const result = await lowLevel.get({ url: "/global/health" })
  if (result.error) {
    throw new Error(
      `configure: host opencode server returned an error from /global/health: ${stringifyError(result.error)}`,
    )
  }
  const data = result.data as { healthy?: boolean; version?: string } | undefined
  if (!data || typeof data.version !== "string" || !data.version) {
    throw new Error("configure: host opencode server did not report a version in /global/health")
  }
  return data.version
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Build a Vercel sandbox name from the workspace's human-readable slug
 * (e.g. `"quiet-wizard"` plus workspace id `wrk_abc123` → `"opencode-quiet-wizard-abc123"`)
 * so it's identifiable in the Vercel dashboard while still being unique.
 *
 * Vercel sandbox names must be unique per project. The slug from
 * `Slug.create()` in opencode is a random adjective-noun pair which can
 * collide — especially after a failed workspace leaves an orphan sandbox
 * with the same slug behind. We suffix every name with the last 6
 * characters of the workspaceId, which makes the name globally unique
 * without losing the human-readable prefix.
 *
 * Fallback shape (workspaceId-only) is kept for the rare case where the
 * slug is missing or fully sanitised away.
 */
export function makeSandboxName(name: string | undefined | null, workspaceId: string): string {
  const slug = (name ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  const idSuffix = workspaceId.replace(/_/g, "-").toLowerCase().slice(-6)
  if (slug.length >= 3) return `opencode-${slug}-${idSuffix}`
  return `opencode-${workspaceId.replace(/_/g, "-").toLowerCase()}`
}
