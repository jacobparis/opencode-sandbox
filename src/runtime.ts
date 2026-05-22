import type { WorkspaceInfo, WorkspaceTarget } from "@opencode-ai/plugin"
import type { Sandbox } from "@vercel/sandbox"
import { decodeExtra, type Context, type WorkspaceExtra } from "./types.js"
import { basicAuthHeader, getExistingSandbox } from "./vercel.js"

/**
 * Absolute path where opencode's official install script writes the binary
 * inside the sandbox. The script hardcodes `INSTALL_DIR=$HOME/.opencode/bin`
 * and does not respect `OPENCODE_INSTALL_DIR`, so we invoke by absolute path.
 */
export const OPENCODE_BIN_PATH = "$HOME/.opencode/bin/opencode"

const PROBE_TIMEOUT_MS = 5_000
const READINESS = {
  // Cold path: `create.ts` has just launched serve. Wait longer; never relaunch.
  initial: { totalMs: 90_000, pollMs: 1_000 },
  // Warm path: `target()` saw an unhealthy serve. Shorter budget, with relaunch.
  recover: { totalMs: 60_000, pollMs: 1_000 },
} as const

type Entry = {
  inflight: Promise<WorkspaceTarget> | null
  heartbeat: ReturnType<typeof setInterval> | null
}

/**
 * Owns the runtime relationship between a workspace and its sandbox.
 *
 * One instance per plugin load. State (inflight target promises, heartbeat
 * timers) is keyed internally by `workspaceId` — callers never see it.
 * Heartbeat intervals are `.unref()`'d so the Node event loop is free to
 * exit even if a tick is scheduled.
 *
 * Public surface (4 methods):
 *   - `target(info)`       — hot path; called by the adapter on every
 *                             `target()` invocation. Dedupes concurrent
 *                             calls, ensures serve is healthy, starts the
 *                             heartbeat on first success.
 *   - `startServe(...)`    — used by `runCreate` to launch the first
 *                             `opencode serve` process inside the sandbox.
 *   - `waitHealthy(...)`   — used by `runCreate` after `startServe`; also
 *                             used internally during recovery.
 *   - `release(id)`        — used by `runRemove` to tear down state for
 *                             one workspace.
 */
export class WorkspaceRuntime {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly ctx: Context) {}

  /** Hot path. Idempotent across concurrent callers per workspace id. */
  async target(info: WorkspaceInfo): Promise<WorkspaceTarget> {
    const entry = this.getEntry(info.id)
    if (entry.inflight) return entry.inflight

    const work = (async () => {
      const extra = decodeExtra(info.extra)
      const sandbox = await getExistingSandbox(extra.sandboxName)
      await this.ensureServeReady(sandbox, extra)
      this.startHeartbeat(info.id, extra)
      return {
        type: "remote" as const,
        url: sandbox.domain(extra.port),
        headers: { Authorization: basicAuthHeader("opencode", extra.serverPassword) },
      }
    })()

    entry.inflight = work.finally(() => {
      entry.inflight = null
    })
    return entry.inflight
  }

  /** Launch `opencode serve` in the sandbox. Used by `runCreate` once at boot. */
  async startServe(sandbox: Sandbox, port: number): Promise<void> {
    await this.ctx.log("info", "runtime: starting opencode serve", { port, name: sandbox.name })
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", buildServeCommand(port)],
      detached: true,
    })
  }

  /**
   * Block until `opencode serve` answers `/global/health`, or throw.
   *   - `mode: "initial"` — used by `runCreate` after `startServe`. 90s budget,
   *     no relaunch attempt (serve was just launched; relaunching would race).
   *   - `mode: "recover"` — used internally by `target()` after relaunching
   *     a stalled serve. 60s budget.
   */
  async waitHealthy(sandbox: Sandbox, extra: WorkspaceExtra, mode: "initial" | "recover"): Promise<void> {
    const { totalMs, pollMs } = READINESS[mode]
    const deadline = Date.now() + totalMs
    let attempt = 0
    while (Date.now() < deadline) {
      attempt += 1
      if (await this.probeOnce(sandbox, extra)) {
        if (attempt > 1) {
          await this.ctx.log("info", "runtime: serve healthy", { name: sandbox.name, attempt, mode })
        }
        return
      }
      await this.ctx.log("debug", "runtime: serve health probe failed", { name: sandbox.name, attempt, mode })
      await sleep(pollMs)
    }
    throw new Error(
      `runtime: opencode serve in ${sandbox.name} did not become healthy within ${totalMs / 1000}s. ` +
        `Sandbox is still running; inspect with \`tail $HOME/opencode-serve.log\` or remove the workspace.`,
    )
  }

  /** Stop heartbeat + drop entry for a workspace. Idempotent. */
  release(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    if (entry.heartbeat) clearInterval(entry.heartbeat)
    this.entries.delete(workspaceId)
  }

  // ---- private ----

  private getEntry(id: string): Entry {
    const existing = this.entries.get(id)
    if (existing) return existing
    const fresh: Entry = { inflight: null, heartbeat: null }
    this.entries.set(id, fresh)
    return fresh
  }

  /** Probe once; if down, relaunch and wait via the recover-mode budget. */
  private async ensureServeReady(sandbox: Sandbox, extra: WorkspaceExtra): Promise<void> {
    if (await this.probeOnce(sandbox, extra)) return
    await this.ctx.log("info", "runtime: opencode serve not healthy; relaunching", { name: sandbox.name })
    await this.startServe(sandbox, extra.port)
    await this.waitHealthy(sandbox, extra, "recover")
  }

  private async probeOnce(sandbox: Sandbox, extra: WorkspaceExtra): Promise<boolean> {
    const url = new URL("/global/health", sandbox.domain(extra.port))
    const headers = { Authorization: basicAuthHeader("opencode", extra.serverPassword) }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => undefined)
    return Boolean(res?.ok)
  }

  private startHeartbeat(workspaceId: string, extra: WorkspaceExtra): void {
    const entry = this.entries.get(workspaceId)
    if (!entry || entry.heartbeat) return
    const { heartbeatIntervalMs, heartbeatExtendMs } = this.ctx.options
    void this.ctx.log("info", "runtime: starting heartbeat", {
      workspaceId,
      name: extra.sandboxName,
      intervalMs: heartbeatIntervalMs,
      extendMs: heartbeatExtendMs,
    })
    const handle = setInterval(() => {
      void this.tickHeartbeat(workspaceId, extra)
    }, heartbeatIntervalMs)
    // Don't keep the Node event loop alive solely for this timer; opencode
    // shutdown shouldn't wait on us.
    handle.unref?.()
    entry.heartbeat = handle
  }

  private async tickHeartbeat(workspaceId: string, extra: WorkspaceExtra): Promise<void> {
    try {
      const sandbox = await getExistingSandbox(extra.sandboxName, { resume: false })
      if (sandbox.status !== "running") {
        await this.ctx.log("warn", "runtime: heartbeat stopping (sandbox not running)", {
          name: extra.sandboxName,
          status: sandbox.status,
        })
        this.release(workspaceId)
        return
      }
      await sandbox.extendTimeout(this.ctx.options.heartbeatExtendMs)
      await this.ctx.log("debug", "runtime: heartbeat extended timeout", {
        name: extra.sandboxName,
        extendMs: this.ctx.options.heartbeatExtendMs,
      })
    } catch (err) {
      await this.ctx.log("warn", "runtime: heartbeat failed", {
        name: extra.sandboxName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Launch `opencode serve` so it survives the bash shell exiting.
 * - `cd /vercel/sandbox` so the server's `process.cwd()` is the cloned repo;
 *   opencode's workspace router uses this as the default directory when the
 *   proxy strips the host's `?directory=` query.
 * - `nohup` ignores SIGHUP when the parent shell terminates.
 * - `&` backgrounds the process so bash returns immediately.
 * - logs tail to a file inside $HOME for post-hoc debugging.
 *
 * Exported for tests that pin the structural invariants of the script.
 */
export function buildServeCommand(port: number): string {
  return `cd /vercel/sandbox && nohup "${OPENCODE_BIN_PATH}" serve --hostname 0.0.0.0 --port ${port} >> "$HOME/opencode-serve.log" 2>&1 &`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
