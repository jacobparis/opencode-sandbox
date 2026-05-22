import { APIError, Sandbox } from "@vercel/sandbox"
import type { NetworkPolicy } from "@vercel/sandbox"
import type { Context, WorkspaceExtra } from "./types.js"

export type CreateSandboxOpts = {
  ctx: Context
  extra: WorkspaceExtra
  env: Record<string, string>
  githubToken: string
  networkPolicy: NetworkPolicy
  signal?: AbortSignal
}

/**
 * Create a fresh persistent sandbox cloning the workspace's git ref.
 * The sandbox name is taken from `extra.sandboxName` (unique per Vercel project)
 * and the opencode server password is injected via `env.OPENCODE_SERVER_PASSWORD`
 * which the caller has already merged in.
 */
export async function createPersistentSandbox(opts: CreateSandboxOpts): Promise<Sandbox> {
  // De-dupe in case a user re-adds 4096 to `extraPorts`. Vercel allows up to
  // 4 ports per sandbox, so we cap at the SDK ceiling to avoid a confusing
  // platform error on accidentally-large lists.
  const ports = Array.from(new Set([opts.extra.port, ...opts.ctx.options.extraPorts])).slice(0, 4)
  return Sandbox.create({
    name: opts.extra.sandboxName,
    persistent: true,
    runtime: opts.ctx.options.runtime,
    resources: { vcpus: opts.ctx.options.vcpus },
    ports,
    snapshotExpiration: opts.ctx.options.snapshotExpiration,
    networkPolicy: opts.networkPolicy,
    // Vercel's default is 5 minutes which expires mid-conversation. Use the
    // configured ceiling (clamped server-side to the user's plan max). The
    // heartbeat in target.ts keeps extending while the workspace is open.
    timeout: opts.ctx.options.sessionTimeoutMs,
    source: {
      type: "git",
      url: opts.extra.gitUrl,
      username: "x-access-token",
      password: opts.githubToken,
      revision: opts.extra.gitRef,
      depth: 1,
    },
    env: opts.env,
    signal: opts.signal,
  })
}

/**
 * Look up an existing sandbox by name. `resume` defaults to true so the
 * sandbox is woken up if it's currently stopped (which the SDK supports for
 * persistent sandboxes).
 */
export async function getExistingSandbox(
  name: string,
  opts?: { signal?: AbortSignal; resume?: boolean },
): Promise<Sandbox> {
  return Sandbox.get({
    name,
    resume: opts?.resume ?? true,
    signal: opts?.signal,
  })
}

export function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
}

export function isSandboxNotFoundError(err: unknown): boolean {
  if (err instanceof APIError) {
    return err.response.status === 404
  }
  if (!err || typeof err !== "object") return false
  const e = err as { message?: unknown; code?: unknown; status?: unknown }
  if (e.code === "not_found" || e.code === "sandbox_not_found") return true
  if (e.status === 404) return true
  if (typeof e.message === "string" && /not[\s_-]?found/i.test(e.message)) return true
  return false
}
