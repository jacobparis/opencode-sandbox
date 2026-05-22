import type { WorkspaceInfo } from "@opencode-ai/plugin"
import type { Sandbox } from "@vercel/sandbox"
import { fileURLToPath } from "node:url"
import { resolveGithubToken } from "./auth/github.js"
import { buildNetworkPolicy } from "./network-policy.js"
import { OPENCODE_BIN_PATH, WorkspaceRuntime } from "./runtime.js"
import { decodeExtra, type Context, type WorkspaceExtra } from "./types.js"
import { createPersistentSandbox } from "./vercel.js"
import { pullVercel } from "./pull-vercel.js"
import { applyUncommittedFromHost } from "./uncommitted.js"

/**
 * Absolute filesystem path of this plugin's entry on the **host**. opencode
 * resolves the user's `opencode.json` plugin spec to this concrete file and
 * persists the absolute path. When the sandbox's opencode-serve later reads
 * the cloned `opencode.json`, it will try to import that same host path
 * (which does not exist in the sandbox) and emit a session-error event that
 * the host TUI replays as a toast.
 *
 * Once the plugin is published to npm and referenced as `"opencode-sandbox"`,
 * the spec will not be an absolute path and the sandbox's opencode will
 * resolve+install it normally. Until then, `stripHostPluginFromClonedConfig`
 * surgically drops only entries that match this absolute path.
 *
 * `create.ts` builds to `dist/create.js`; the entry sits next to us as
 * `./index.js`.
 */
export const PLUGIN_ENTRY_PATH = fileURLToPath(new URL("./index.js", import.meta.url))

/**
 * Provision a Vercel Sandbox, bootstrap opencode inside it, and wait for the
 * remote `opencode serve` to become healthy.
 *
 * Failure semantics match opencode's own behaviour: if any step throws, the
 * partially-created sandbox is left in place. opencode keeps the workspace
 * row in the same situation, and `adapter.remove()` cleans both layers up
 * symmetrically. Leaving the sandbox around also keeps it inspectable for
 * debugging (`ps`, `tail $HOME/opencode-serve.log`, etc.).
 */
export async function runCreate(
  ctx: Context,
  runtime: WorkspaceRuntime,
  info: WorkspaceInfo,
  env: Record<string, string | undefined>,
): Promise<void> {
  const extra = decodeExtra(info.extra)
  const githubToken = await resolveGithubToken({ $: ctx.input.$, githubToken: ctx.options.githubToken })
  const sandboxEnv = buildSandboxEnv(env, extra)
  const networkPolicy = buildNetworkPolicy({
    egressPolicy: ctx.options.egressPolicy,
    extraAllowDomains: ctx.options.extraAllowDomains,
  })

  await ctx.log("info", "create: provisioning sandbox", {
    workspaceId: info.id,
    name: extra.sandboxName,
    runtime: ctx.options.runtime,
    vcpus: ctx.options.vcpus,
    gitRef: extra.gitRef,
    opencodeVersion: extra.opencodeVersion,
    egressPolicy: ctx.options.egressPolicy,
    extraPorts: ctx.options.extraPorts,
  })

  const sandbox = await createPersistentSandbox({ ctx, extra, env: sandboxEnv, githubToken, networkPolicy })
  await ctx.log("info", "create: sandbox provisioned", { name: sandbox.name })

  await writeProjectId(sandbox, info.projectID)
  await ctx.log("info", "create: wrote project id into .git/opencode", { name: sandbox.name })

  await setupGitBranch(ctx, sandbox, extra.gitRef, githubToken, extra.gitUrl)

  if (extra.includeUncommitted) {
    await applyUncommittedFromHost(ctx, sandbox, extra.gitRef)
  }

  if (ctx.options.pullVercel) {
    await pullVercel(ctx, sandbox, ctx.options.vercelEnvTarget)
  }

  await stripHostPluginFromClonedConfig(ctx, sandbox)

  await installOpencode(ctx, sandbox, extra.opencodeVersion)
  await ctx.log("info", "create: opencode installed", { name: sandbox.name, version: extra.opencodeVersion })

  await runtime.startServe(sandbox, extra.port)
  await runtime.waitHealthy(sandbox, extra, "initial")
  await ctx.log("info", "create: serve healthy", { name: sandbox.name })
}

function buildSandboxEnv(
  env: Record<string, string | undefined>,
  extra: WorkspaceExtra,
): Record<string, string> {
  // TODO(security): once opencode exposes per-provider auth introspection to
  // plugins, replace this verbatim passthrough with credential brokering: strip
  // provider secrets from `OPENCODE_AUTH_CONTENT` here and attach matching
  // `transform.headers` rules to `networkPolicy.allow` so the sandbox VM never
  // sees the raw tokens. Pattern: vercel.com/kb/guide/run-claude-managed-agent-tools-with-vercel-sandbox
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v
  }
  out.OPENCODE_SERVER_PASSWORD = extra.serverPassword
  return out
}

async function writeProjectId(sandbox: Sandbox, projectId: string): Promise<void> {
  await sandbox.writeFiles([
    {
      path: ".git/opencode",
      content: Buffer.from(projectId),
    },
  ])
}

/**
 * The Vercel Sandbox SDK clones with `depth: 1` and leaves HEAD pointing at a
 * raw commit SHA. Inside that clone:
 *
 *   - `git branch --show-current` returns the empty string
 *   - `git log <branch>..HEAD` is empty even when the agent has new commits
 *   - `git rev-list --count HEAD` is 1
 *   - `.git/refs/remotes/origin/` is empty
 *
 * That's hostile to anything branch-aware (commit hooks, `gh pr create`,
 * tooling that compares against `origin/<branch>`). This step gets the clone
 * back to a normal layout:
 *
 *   1. `git fetch --unshallow` so history works.
 *   2. Create a local branch ref at HEAD and point HEAD at it.
 *   3. Set `branch.<name>.{remote,merge}` so upstream tracking works.
 *
 * Authentication uses a one-shot `http.extraHeader` so the token never lands
 * in `.git/config`. Each step is best-effort: on failure we log and continue,
 * because the underlying clone is still usable even if these niceties fail.
 */
async function setupGitBranch(
  ctx: Context,
  sandbox: Sandbox,
  branch: string,
  githubToken: string,
  gitUrl: string,
): Promise<void> {
  const host = new URL(gitUrl).host
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString("base64")
  // Quote the header carefully: it contains a space and a colon. Wrap in
  // single quotes inside the bash command, and escape any single quotes in
  // the encoded token (base64 never produces them, so this is defensive).
  const authHeader = `Authorization: Basic ${basic}`
  const script = [
    `set -e`,
    `cd /vercel/sandbox`,
    // Unshallow if shallow. `--unshallow` errors on already-complete repos,
    // so guard with `is-shallow-repository` and don't fail the whole step.
    `if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then`,
    `  git -c http.https://${host}/.extraHeader=${shellEscape(authHeader)} fetch --unshallow --no-tags origin ${shellEscape(branch)} || echo "warn: unshallow fetch failed; continuing with shallow history" >&2`,
    `fi`,
    // Create the local branch ref at current HEAD and switch to it. We don't
    // use `git checkout -b` because that errors when the branch already
    // exists; `update-ref` + `symbolic-ref` are idempotent.
    `git update-ref ${shellEscape(`refs/heads/${branch}`)} HEAD`,
    `git symbolic-ref HEAD ${shellEscape(`refs/heads/${branch}`)}`,
    // The SDK's clone doesn't set up `remote.origin.fetch`, which means git's
    // upstream-tracking logic can't map `refs/heads/<branch>` on the remote
    // to `refs/remotes/origin/<branch>` locally. Without this, `@{upstream}`,
    // `git status -sb`, and `git branch -vv` all fail to annotate the branch.
    `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    // Mark origin/<branch> as the upstream tracking ref. If the fetch above
    // succeeded this already exists; if not, point it at the current HEAD so
    // tracking still resolves (it'll just show "up to date").
    `git update-ref ${shellEscape(`refs/remotes/origin/${branch}`)} HEAD`,
    `git config ${shellEscape(`branch.${branch}.remote`)} origin`,
    `git config ${shellEscape(`branch.${branch}.merge`)} ${shellEscape(`refs/heads/${branch}`)}`,
  ].join("\n")

  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] })
  if (result.exitCode !== 0) {
    const stderr = await result.stderr()
    await ctx.log("warn", "create: git branch setup did not fully complete", {
      branch,
      exitCode: result.exitCode,
      stderr: stderr.slice(0, 500),
    })
    return
  }
  await ctx.log("info", "create: git branch + upstream tracking configured", { branch })
}

/**
 * Drop entries from the cloned `opencode.json` / `opencode.jsonc` whose plugin
 * spec is this host's absolute path to opencode-sandbox. The sandbox's
 * opencode-serve would otherwise try to `await import()` that path inside the
 * sandbox, hit `ERR_MODULE_NOT_FOUND`, and publish a session-error event the
 * host TUI replays as a "Failed to load plugin" toast.
 *
 * Only the exact host-absolute path is removed. Any other plugin entries —
 * including npm specs like `"opencode-sandbox"` once published — are kept,
 * which preserves the "warp into a sandbox from a sandbox" workflow.
 *
 * Modifies the cloned working tree (will show in `git status` inside the
 * sandbox). The sandbox is ephemeral so that's acceptable.
 */
async function stripHostPluginFromClonedConfig(ctx: Context, sandbox: Sandbox): Promise<void> {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = `/vercel/sandbox/${name}`
    const read = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `test -f ${shellEscape(path)} && cat ${shellEscape(path)} || true`],
    })
    if (read.exitCode !== 0) continue
    const original = await read.stdout()
    if (!original.trim()) continue

    const rewritten = removePluginSpec(original, PLUGIN_ENTRY_PATH)
    if (rewritten === undefined) {
      await ctx.log("debug", "create: cloned config did not reference the host plugin path", {
        file: name,
        host: PLUGIN_ENTRY_PATH,
      })
      continue
    }

    const encoded = Buffer.from(rewritten).toString("base64")
    // Write the stripped contents and tell git to pretend the file is
    // unchanged. `skip-worktree` is preferred over `assume-unchanged` because
    // the file IS deliberately modified — we want git to use the index
    // version (the unmodified clone) for diffing and commit operations while
    // keeping our stripped contents on disk for opencode-serve to read.
    const write = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        `set -e; cd /vercel/sandbox; printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(name)}; git update-index --skip-worktree ${shellEscape(name)}`,
      ],
    })
    if (write.exitCode !== 0) {
      const stderr = await write.stderr()
      throw new Error(`create: failed to rewrite ${path} (exit ${write.exitCode})\n${stderr}`)
    }
    await ctx.log("info", "create: stripped host plugin spec from cloned opencode config", {
      file: name,
      host: PLUGIN_ENTRY_PATH,
    })
    return
  }
}

/**
 * Return the input config text with any plugin entries matching `hostPath`
 * removed. Returns `undefined` if no entry matched (so caller can skip the
 * write).
 *
 * Plugin specs in opencode.json take one of two shapes:
 *   - a bare string `"<spec>"`
 *   - a 2-tuple `["<spec>", { options }]`
 * We compare the spec (first element) to `hostPath` and drop matches.
 * Everything else — npm specs, relative paths, other absolute paths — is
 * preserved.
 *
 * Comments (jsonc) are stripped before parsing and not re-emitted. The sandbox
 * copy is ephemeral and only consumed by opencode itself, so that's fine.
 */
export function removePluginSpec(source: string, hostPath: string): string | undefined {
  const data = parseJsonc(source)
  if (!isRecord(data) || !Array.isArray(data.plugin)) return undefined
  const next = data.plugin.filter((entry) => {
    if (typeof entry === "string") return entry !== hostPath
    if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0] !== hostPath
    return true
  })
  if (next.length === data.plugin.length) return undefined
  if (next.length === 0) delete (data as Record<string, unknown>).plugin
  else data.plugin = next
  return JSON.stringify(data, null, 2) + "\n"
}

/**
 * Tolerant JSON / JSONC parser: strips line comments, block comments, and
 * trailing commas, then `JSON.parse`s. Returns `undefined` on parse error.
 * Quoted strings are preserved (we skip over them so `//` inside a string
 * does not start a comment).
 */
function parseJsonc(text: string): unknown {
  const stripped = stripJsoncSyntax(text)
  try {
    return JSON.parse(stripped)
  } catch {
    return undefined
  }
}

function stripJsoncSyntax(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '"') {
      // Copy a JSON string verbatim, honouring escapes.
      out += c
      i += 1
      while (i < text.length) {
        const ch = text[i]
        out += ch
        if (ch === "\\" && i + 1 < text.length) {
          out += text[i + 1]
          i += 2
          continue
        }
        i += 1
        if (ch === '"') break
      }
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  // Drop trailing commas that JSONC tolerates but JSON does not.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function installOpencode(ctx: Context, sandbox: Sandbox, version: string): Promise<void> {
  await ctx.log("info", "create: installing opencode", { version })
  // The install script hardcodes INSTALL_DIR=$HOME/.opencode/bin (see opencode's
  // ./install line 68). It does NOT honour OPENCODE_INSTALL_DIR. After the
  // install the binary lives at OPENCODE_BIN_PATH below; we invoke it by
  // absolute path so we don't depend on the script's shell-rc PATH munging.
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `set -e; curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}; test -x "${OPENCODE_BIN_PATH}" || { echo "opencode missing at ${OPENCODE_BIN_PATH}" >&2; exit 1; }`,
    ],
  })
  if (result.exitCode !== 0) {
    const stderr = await result.stderr()
    throw new Error(`create: opencode install failed (exit ${result.exitCode})\n${stderr}`)
  }
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}
