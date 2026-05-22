import type { WorkspaceInfo } from "@opencode-ai/plugin"
import { WorkspaceRuntime } from "./runtime.js"
import { decodeExtra, type Context } from "./types.js"
import { getExistingSandbox, isSandboxNotFoundError } from "./vercel.js"

export async function runRemove(
  ctx: Context,
  runtime: WorkspaceRuntime,
  info: WorkspaceInfo,
): Promise<void> {
  // Tear down the runtime entry (heartbeat + inflight) before deleting the
  // sandbox so we don't keep calling extendTimeout against a sandbox that
  // no longer exists.
  runtime.release(info.id)
  const extra = tryDecode(info.extra)
  if (!extra) {
    await ctx.log("warn", "remove: workspace has no sandbox metadata; nothing to delete", {
      workspaceId: info.id,
    })
    return
  }
  await ctx.log("info", "remove: deleting sandbox", { name: extra.sandboxName })
  try {
    const sandbox = await getExistingSandbox(extra.sandboxName, { resume: false })
    await sandbox.delete()
    await ctx.log("info", "remove: deleted", { name: extra.sandboxName })
  } catch (err) {
    if (isSandboxNotFoundError(err)) {
      await ctx.log("info", "remove: sandbox already gone", { name: extra.sandboxName })
      return
    }
    throw err
  }
}

function tryDecode(extra: unknown) {
  try {
    return decodeExtra(extra)
  } catch {
    return undefined
  }
}
