import type { PluginInput } from "@opencode-ai/plugin"

type Shell = PluginInput["$"]

export class GithubAuthError extends Error {
  override readonly name = "GithubAuthError"
}

export type GithubRemote = {
  httpsUrl: string
  host: string
  owner: string
  repo: string
}

/**
 * Resolve a GitHub token using the agreed chain:
 *   1. plugin option `githubToken`
 *   2. `GITHUB_TOKEN` or `GH_TOKEN` env vars
 *   3. `gh auth token` if the GitHub CLI is installed and authenticated
 *
 * Throws {@link GithubAuthError} when none are available.
 */
export async function resolveGithubToken(opts: { $: Shell; githubToken?: string }): Promise<string> {
  if (opts.githubToken) return opts.githubToken
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  const fromGh = await tryGhAuthToken(opts.$)
  if (fromGh) return fromGh
  throw new GithubAuthError(
    "No GitHub token found. Run `gh auth login`, set GITHUB_TOKEN/GH_TOKEN, or configure the `githubToken` plugin option.",
  )
}

async function tryGhAuthToken($: Shell): Promise<string | undefined> {
  const result = await $`gh auth token`.nothrow().quiet()
  if (result.exitCode !== 0) return undefined
  const token = result.stdout.toString("utf8").trim()
  return token || undefined
}

/**
 * Normalize a git origin URL (HTTPS or SSH) to its HTTPS form and surface the
 * owner/repo so we can both pass HTTPS to Vercel Sandbox and call the GitHub
 * REST API for access verification. v1 supports github.com only.
 */
export function normalizeGitOriginToHttps(url: string): GithubRemote {
  const sshShort = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url)
  if (sshShort) return parseHttps(`https://${sshShort[1]}/${sshShort[2]}.git`)

  const sshProto = /^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (sshProto) return parseHttps(`https://${sshProto[1]}/${sshProto[2]}.git`)

  const gitProto = /^git:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (gitProto) return parseHttps(`https://${gitProto[1]}/${gitProto[2]}.git`)

  if (url.startsWith("https://") || url.startsWith("http://")) {
    return parseHttps(url.endsWith(".git") ? url : `${url}.git`)
  }

  throw new GithubAuthError(`Unsupported git remote URL: ${url}`)
}

function parseHttps(url: string): GithubRemote {
  const match = /^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (!match) throw new GithubAuthError(`Unsupported git remote URL: ${url}`)
  const [, host, owner, repo] = match
  return { httpsUrl: url, host, owner, repo }
}

/**
 * Probe the GitHub REST API to confirm the token can actually read the repo.
 * Catches typos, expired tokens, and missing scopes before we spend money on a
 * sandbox we'd just have to delete.
 */
export async function verifyGithubRepoAccess(token: string, owner: string, repo: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "opencode-sandbox-plugin",
      Accept: "application/vnd.github+json",
    },
  })
  if (res.ok) return
  if (res.status === 401 || res.status === 403) {
    throw new GithubAuthError(
      `GitHub token does not have access to ${owner}/${repo} (HTTP ${res.status}). Check token scopes (needs at least \`repo\` for private repos).`,
    )
  }
  if (res.status === 404) {
    throw new GithubAuthError(
      `Repo ${owner}/${repo} not found or token lacks access (HTTP 404).`,
    )
  }
  throw new GithubAuthError(`Failed to verify GitHub access for ${owner}/${repo} (HTTP ${res.status}).`)
}
