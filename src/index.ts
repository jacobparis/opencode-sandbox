import type {
  Plugin,
  PluginInput,
  PluginModule,
  WorkspaceAdapter,
  WorkspaceInfo,
} from "@opencode-ai/plugin"
import { runConfigure } from "./configure.js"
import { runCreate } from "./create.js"
import { parseOptions } from "./options.js"
import { runRemove } from "./remove.js"
import { WorkspaceRuntime } from "./runtime.js"
import type { Context, Logger } from "./types.js"

const DEBUG_ENABLED = process.env.OPENCODE_SANDBOX_DEBUG === "1"

export const server: Plugin = async (input, pluginOptions) => {
  const options = parseOptions(pluginOptions)
  const log = createLogger(input.client, input.directory)

  input.experimental_workspace.register("vercel-sandbox", makeAdapter({ input, options, log }))

  return {}
}

export default {
  id: "opencode-vercel-sandbox",
  server,
} satisfies PluginModule

function createLogger(client: PluginInput["client"], directory: string): Logger {
  return async (level, message, extra) => {
    if (level === "debug" && !DEBUG_ENABLED) return
    try {
      await client.app.log({
        body: { service: "vercel-sandbox", level, message, extra },
        query: { directory },
      })
    } catch (err) {
      // Fall back to the local console if the host log endpoint isn't reachable.
      console.error(`[vercel-sandbox] log failed (${level}): ${message}`, err)
    }
  }
}

function makeAdapter(ctx: Context): WorkspaceAdapter {
  const runtime = new WorkspaceRuntime(ctx)
  return {
    name: "Vercel Sandbox",
    description: "Run this session in a Vercel Sandbox (persistent microVM)",
    configure: (info) => withErrorLogging(ctx, "configure", info, () => runConfigure(ctx, info)),
    create: (info, env) => withErrorLogging(ctx, "create", info, () => runCreate(ctx, runtime, info, env)),
    target: (info) => withErrorLogging(ctx, "target", info, () => runtime.target(info)),
    remove: (info) => withErrorLogging(ctx, "remove", info, () => runRemove(ctx, runtime, info)),
  }
}

/**
 * opencode surfaces adapter failures to the UI as a generic
 * "Creating workspace failed" with no detail. Log the full error here so
 * `~/.local/share/opencode/log/*.log` always has the actual cause, then
 * re-throw with a prefixed message so opencode's own logging carries
 * something searchable too.
 */
async function withErrorLogging<T>(
  ctx: Context,
  phase: "configure" | "create" | "target" | "remove",
  info: WorkspaceInfo,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    await ctx.log("error", `${phase}: failed`, {
      workspaceId: info.id,
      type: info.type,
      message,
      stack,
    })
    throw err instanceof Error ? err : new Error(message)
  }
}
