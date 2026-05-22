import type { PluginInput } from "@opencode-ai/plugin"
import type { Options } from "./options.js"

export type { VercelEnvTarget } from "./options.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

export type Context = {
  input: PluginInput
  options: Options
  log: Logger
}

/**
 * Per-workspace state persisted by opencode between sessions. opencode's
 * own worktree API refuses non-git projects (see `WorktreeNotGitError`
 * in `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`), so this plugin
 * only handles git-cloneable workspaces — `gitUrl` and `gitRef` are
 * always populated by `create()` via the Sandbox SDK's git source.
 */
export type WorkspaceExtra = {
  sandboxName: string
  serverPassword: string
  port: number
  gitUrl: string
  gitRef: string
  opencodeVersion: string
  /**
   * When true, `create()` will overlay the host's uncommitted working-tree
   * changes onto the freshly cloned sandbox after the initial clone. Set
   * during `configure()` when the user opted in via `uncommitted: "include"`
   * and the host's working tree was dirty at preflight time.
   */
  includeUncommitted?: boolean
}

const EXTRA_STRING_FIELDS = ["sandboxName", "serverPassword", "gitUrl", "gitRef", "opencodeVersion"] as const

export function decodeExtra(extra: unknown): WorkspaceExtra {
  if (!extra || typeof extra !== "object") {
    throw new Error("vercel-sandbox: workspace extra is missing or not an object")
  }
  const record = extra as Record<string, unknown>
  for (const field of EXTRA_STRING_FIELDS) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`vercel-sandbox: workspace extra.${field} is missing or not a string`)
    }
  }
  if (typeof record.port !== "number" || !Number.isFinite(record.port)) {
    throw new Error("vercel-sandbox: workspace extra.port is missing or not a number")
  }
  return {
    sandboxName: record.sandboxName as string,
    serverPassword: record.serverPassword as string,
    port: record.port as number,
    gitUrl: record.gitUrl as string,
    gitRef: record.gitRef as string,
    opencodeVersion: record.opencodeVersion as string,
    ...(record.includeUncommitted === true ? { includeUncommitted: true } : {}),
  }
}
