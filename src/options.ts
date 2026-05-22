import type { PluginOptions } from "@opencode-ai/plugin"
import type { EgressPolicy } from "./network-policy.js"

export type UncommittedPolicy = "refuse" | "include" | "ignore"
export type VercelEnvTarget = "development" | "preview" | "production"

export type Options = {
  githubToken?: string
  vcpus: number
  runtime: string
  snapshotExpiration: number
  uncommitted: UncommittedPolicy
  egressPolicy: EgressPolicy
  extraAllowDomains: string[]
  sessionTimeoutMs: number
  heartbeatIntervalMs: number
  heartbeatExtendMs: number
  /**
   * Override the opencode version installed inside the sandbox. By default
   * the plugin pins to the host's reported version. Useful when the host is
   * running a dev/patched build (which doesn't exist as a published release)
   * but the sandbox should still install a known stable version.
   */
  opencodeVersion?: string
  /**
   * Additional ports to expose from the sandbox alongside the opencode serve
   * port (4096). Defaults cover the major dev-server framework ports so a
   * `bun dev` / `npm run dev` inside the workspace can be reached at
   * `sandbox.domain(port)`.
   */
  extraPorts: number[]
  /**
   * When true, mirror the host's Vercel project state (`.vercel/` directory
   * + microfrontends config) into the sandbox during `create()`. Runs
   * `vercel pull` on the host, plus `vercel microfrontends pull` when the
   * project uses microfrontends. Requires the Vercel CLI on PATH and a
   * linked project (`.vercel/project.json` in the worktree). Fails open \u2014
   * the sandbox still gets created if the pull steps error.
   */
  pullVercel: boolean
  /**
   * Which Vercel environment to pull when `pullVercel` is true. Defaults to
   * `"development"` to match `vercel pull`'s own default.
   */
  vercelEnvTarget: VercelEnvTarget
}

/**
 * Vercel's hard ceiling for `Sandbox.create({ timeout })` is 18,000,000ms
 * (5 hours). We reserve a 30-second buffer for the heartbeat to land its
 * final `extendTimeout` call before the SDK kills the session, so we clamp
 * any user-provided value below the ceiling minus that buffer.
 */
const VERCEL_SDK_TIMEOUT_BUFFER_MS = 30_000
const VERCEL_MAX_SESSION_TIMEOUT_MS = 18_000_000 - VERCEL_SDK_TIMEOUT_BUFFER_MS

const DEFAULTS = {
  vcpus: 2,
  runtime: "node24",
  snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
  uncommitted: "refuse" as UncommittedPolicy,
  egressPolicy: "default" as EgressPolicy,
  // Vercel's default session timeout is 5 minutes. We bump to 45min (the
  // Hobby plan ceiling) and lean on the heartbeat to keep extending. Pro/
  // Enterprise users can bump higher via the `sessionTimeoutMs` option (up
  // to 5h).
  sessionTimeoutMs: 45 * 60 * 1000,
  // Extend every 5 minutes by 15 minutes: at any moment the sandbox has
  // \u226510 minutes of headroom, which survives a slow LLM call without
  // requiring per-request bookkeeping.
  heartbeatIntervalMs: 5 * 60 * 1000,
  heartbeatExtendMs: 15 * 60 * 1000,
  // 4096 is the opencode serve port (added in create.ts). These cover the
  // common dev-server defaults: 3000 (Next/Express/Remix), 5173 (Vite/
  // SvelteKit), 4321 (Astro), 8000 (Django/general).
  extraPorts: [3000, 5173, 4321, 8000] as readonly number[],
  pullVercel: true,
  vercelEnvTarget: "development" as VercelEnvTarget,
}

export function parseOptions(opts: PluginOptions | undefined): Options {
  const rawTimeout = readNumber(opts, "sessionTimeoutMs") ?? DEFAULTS.sessionTimeoutMs
  return {
    githubToken: readString(opts, "githubToken"),
    vcpus: readNumber(opts, "vcpus") ?? DEFAULTS.vcpus,
    runtime: readString(opts, "runtime") ?? DEFAULTS.runtime,
    snapshotExpiration: readNumber(opts, "snapshotExpiration") ?? DEFAULTS.snapshotExpiration,
    uncommitted: readUncommitted(opts),
    egressPolicy: readEgressPolicy(opts),
    extraAllowDomains: readStringArray(opts, "extraAllowDomains"),
    sessionTimeoutMs: Math.min(rawTimeout, VERCEL_MAX_SESSION_TIMEOUT_MS),
    heartbeatIntervalMs: readNumber(opts, "heartbeatIntervalMs") ?? DEFAULTS.heartbeatIntervalMs,
    heartbeatExtendMs: readNumber(opts, "heartbeatExtendMs") ?? DEFAULTS.heartbeatExtendMs,
    opencodeVersion: readString(opts, "opencodeVersion"),
    extraPorts: readNumberArray(opts, "extraPorts") ?? [...DEFAULTS.extraPorts],
    pullVercel: readBoolean(opts, "pullVercel") ?? DEFAULTS.pullVercel,
    vercelEnvTarget: readVercelEnvTarget(opts),
  }
}

function readString(opts: PluginOptions | undefined, key: string): string | undefined {
  const v = opts?.[key]
  return typeof v === "string" && v.trim() ? v : undefined
}

function readNumber(opts: PluginOptions | undefined, key: string): number | undefined {
  const v = opts?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function readBoolean(opts: PluginOptions | undefined, key: string): boolean | undefined {
  const v = opts?.[key]
  return typeof v === "boolean" ? v : undefined
}

function readUncommitted(opts: PluginOptions | undefined): UncommittedPolicy {
  const v = opts?.uncommitted
  if (v === "refuse" || v === "include" || v === "ignore") return v
  return DEFAULTS.uncommitted
}

function readEgressPolicy(opts: PluginOptions | undefined): EgressPolicy {
  const v = opts?.egressPolicy
  if (v === "default" || v === "allow-all") return v
  return DEFAULTS.egressPolicy
}

function readVercelEnvTarget(opts: PluginOptions | undefined): VercelEnvTarget {
  const v = opts?.vercelEnvTarget
  if (v === "development" || v === "preview" || v === "production") return v
  return DEFAULTS.vercelEnvTarget
}

function readStringArray(opts: PluginOptions | undefined, key: string): string[] {
  const v = opts?.[key]
  if (!Array.isArray(v)) return []
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function readNumberArray(opts: PluginOptions | undefined, key: string): number[] | undefined {
  const v = opts?.[key]
  if (!Array.isArray(v)) return undefined
  return v.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0)
}
