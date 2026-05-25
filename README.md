# opencode-sandbox

OpenCode workspace plugin that runs sessions in [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

Each workspace becomes a persistent Vercel Sandbox (beta), cloned from your repo's `origin` at the current branch, with `opencode serve` running inside it. OpenCode proxies all requests into the sandbox over HTTPS, secured by per-workspace Basic auth.

## Status

Workspace creation, sandbox provisioning, opencode install, and workspace teardown all work against opencode `1.15.10` (latest stable as of writing).

**Streaming chat responses from the sandbox back to the host TUI requires [opencode PR #26076](https://github.com/anomalyco/opencode/pull/26076)** to be merged. That PR adds a single line to opencode's `workspaceProxyURL` to strip the host's `?directory=` query param before forwarding requests to sandbox-side opencode. Without it, the sandbox falls back to `worktree="/"`, which corrupts `path.relative()` calls, wipes the TUI's session list, and prevents streaming events from replaying through `workspace-sync`. The plugin's runtime module already comments on this assumption (see `src/runtime.ts:194`).

Until PR #26076 ships:

- Either run a custom-built opencode with the patch applied (`git clone https://github.com/anomalyco/opencode`, apply the diff, `bun install && bun run build`, replace `~/.opencode/bin/opencode`)
- Or accept that sandboxed workspaces can be *created and managed* but chat responses won't stream back through the TUI

## Requirements

- OpenCode `>= 1.15.5` (uses the `experimental_workspace.register` plugin API)
- Vercel Sandbox enabled on your account and a Vercel project linked in the current directory (`vercel link`). The plugin uses [Vercel OIDC](https://vercel.com/docs/oidc) for auth; `vercel env pull` is the easiest way to get a `VERCEL_OIDC_TOKEN` locally.
- A GitHub token reachable via one of: `gh auth login`, `GITHUB_TOKEN` / `GH_TOKEN` env, or the `githubToken` plugin option. Only `github.com` remotes are supported in v1.
- The branch you want to sandbox must be pushed to `origin` (have an upstream tracking ref). Uncommitted changes are refused by default; see the `uncommitted` option.
- Only **git projects** are supported. opencode's own `/experimental/worktree` endpoint refuses non-git projects with `WorktreeNotGitError` before our plugin is even called (see `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1062`).

## Configure

`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./src/index.ts"]
  ]
}
```

Or installed from npm later:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sandbox"]
}
```

### Options

All optional; pass as the second element of the plugin tuple:

```jsonc
"plugin": [["opencode-sandbox", {
  "githubToken": "ghp_...",          // fallback when gh/env aren't present
  "vcpus": 2,                         // default 2
  "runtime": "node24",                // default "node24"
  "snapshotExpiration": 604800000,    // ms, default 7 days
  "uncommitted": "refuse",            // "refuse" (default) | "include" (overlay diff onto sandbox) | "ignore" (clean clone)
  "egressPolicy": "default",          // "default" (curated allowlist) | "allow-all"
  "extraAllowDomains": [],            // additional domains to allow alongside the curated list
  "sessionTimeoutMs": 2700000,        // default 45min, clamped to Vercel SDK ceiling
  "heartbeatIntervalMs": 300000,      // how often `target()` re-extends the session, default 5min
  "heartbeatExtendMs": 900000,        // how much each heartbeat extends by, default 15min
  "opencodeVersion": "1.15.5",        // pin sandbox opencode version (default: host's version)
  "extraPorts": [3000, 5173, 4321, 8000],   // dev-server ports to expose alongside 4096
  "pullVercel": true,                 // mirror Vercel project artifacts into sandbox
  "vercelEnvTarget": "development"    // "development" | "preview" | "production"
}]]
```

### `pullVercel`

When `pullVercel: true` (default), the plugin runs `vercel pull --environment=<target>` on the host during `create()`, then mirrors the resulting `<worktree>/.vercel/` directory (project link + `.env.<env>.local` + any other Vercel-managed files) into the sandbox at the same paths. Dev servers, build scripts, and any sandbox-side `vercel ...` invocations see the same project state the user has locally.

If the project uses Vercel Microfrontends — detected by the presence of `microfrontends.json` at the repo root or `.vercel/microfrontends.json`, or by `@vercel/microfrontends` in `package.json` dependencies — the plugin also runs `vercel microfrontends pull` on the host and mirrors the updated config.

All files are passed through byte-for-byte; no parsing or transformation by the plugin.

Requirements:
- `vercel` CLI on the host's `PATH`
- A linked Vercel project (`.vercel/project.json` in the worktree, produced by `vercel link`)

Failures (missing CLI, no project link, network error, command non-zero) are logged as warnings and skipped; the sandbox is still created. Host env vars (provider auth, opencode control envelope) pass through normally regardless.

> **Note**: Vercel Sandbox's default session timeout is 5 minutes \u2014 way too short for opencode chat sessions. The plugin starts each sandbox with the larger `sessionTimeoutMs` and keeps a heartbeat running from `target()` that calls `sandbox.extendTimeout()` every `heartbeatIntervalMs` while the workspace is open. The heartbeat is stopped automatically by `remove()` and by the workspace transitioning to a non-running state.

## Run

Workspaces are gated behind an experimental flag:

```sh
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

In opencode, open the session list and press `ctrl+w` → select **Vercel Sandbox**.

For development of this plugin, `bun run dev` runs opencode from this directory with the plugin loaded directly from `./src/index.ts`.

## What the adapter does

- **`configure`** runs on the host: verifies Vercel OIDC, reads your git remote/branch, refuses dirty trees, resolves a GitHub token, probes the GitHub REST API to confirm access, fetches the host opencode version, and generates a sandbox name + 32-byte server password.
- **`create`** spins up a persistent Vercel Sandbox cloning your repo at the current branch (`depth: 1`), writes `project.id` to `.git/opencode`, optionally overlays the host's uncommitted working-tree changes (when `uncommitted: "include"`), optionally syncs the Vercel project artifacts (when `pullVercel: true`), installs the matching opencode version via the official install script (`$HOME/.opencode/bin/opencode`), launches `opencode serve` detached on port 4096 with output tailed to `$HOME/opencode-serve.log`, and waits for `/global/health` to return 200. **On failure the sandbox is left in place** (matches opencode's worktree adapter, which also leaves partial state on failure). The workspace row in opencode's DB persists too; calling `remove` cleans both up.

### `uncommitted: "include"`

When the host's working tree is dirty and the option is set to `"include"`, `create` captures two things on the host:

1. `git diff origin/<branch> --binary --no-color` — covers tracked changes (modified, added, deleted, renamed) **and any unpushed local commits**. Diffing against `origin/<branch>` rather than `HEAD` matters because the sandbox just cloned the origin tip; a patch generated against host `HEAD` wouldn't apply cleanly if the host has commits beyond origin.
2. `git ls-files --others --exclude-standard -z` — untracked files, respecting `.gitignore`.

Both are shipped via `sandbox.writeFiles`, then the sandbox runs `git apply --whitespace=nowarn` on the diff. Anything ignored by `.gitignore` (`node_modules`, `.env.local`, `dist/`, etc.) intentionally doesn't transfer — use `pullVercel` for env vars or include them in the project setup separately.

If `git fetch origin <branch>` fails before the diff capture (offline, no access), the plugin falls back to diffing against host `HEAD` and logs a warning. The apply may then fail if the host has unpushed commits.
- **`target`** lazily resumes the sandbox via `Sandbox.get({ resume: true })`, re-launches `opencode serve` if the snapshot restore left it dead, and returns `{ type: "remote", url, headers: { Authorization: "Basic …" } }`.
- **`remove`** hard-deletes the sandbox via `sandbox.delete()` (idempotent — not-found is treated as success).

## Security

The sandbox is a fresh microVM with its own filesystem and network. Two layers protect what's inside it from leaking outward:

### Egress allowlist (enabled by default)

`egressPolicy: "default"` configures a `networkPolicy.allow` list at the Vercel Sandbox firewall covering what opencode workspaces typically need: GitHub, opencode.ai, common package registries, and the major AI provider domains (OpenAI, Anthropic, Cohere, Mistral, Groq, Together, DeepSeek, xAI, Perplexity, Fireworks, Cerebras, OpenRouter, Google Gemini/Vertex, Azure OpenAI, Vercel AI Gateway, AWS Bedrock, GitHub Copilot). The full list lives in `src/network-policy.ts`.

Anything outside the list is denied by the firewall. If the sandbox is compromised (e.g. by a malicious LLM tool call), it cannot POST `process.env` to an arbitrary attacker-controlled host.

- If a domain your project legitimately needs is missing, add it via `extraAllowDomains: ["api.your-service.com"]`. Wildcards are supported: `*.foo.com`, `bar.*.com`.
- To turn the allowlist off entirely, set `egressPolicy: "allow-all"`. Don't do this in production.

### Credential brokering (future)

OpenCode's host passes the full provider auth bundle to the sandbox as `OPENCODE_AUTH_CONTENT` so opencode-in-sandbox can call AI providers on the user's behalf. The bundle is currently visible to anything running inside the VM. The egress allowlist limits the blast radius (a leaked token can't be exfiltrated to an arbitrary host) but does not prevent in-band misuse.

Vercel Sandbox's firewall supports [credential brokering](https://vercel.com/docs/vercel-sandbox/concepts/firewall#credentials-brokering): per-domain header injection so secrets never enter the VM. Wiring that up here requires opencode to expose per-provider auth introspection to plugins — once that exists, the integration point is the env-build site in `src/create.ts` (search for `TODO(security)`).

## Logging

The plugin logs to opencode's server log via `client.app.log` with `service: "vercel-sandbox"`. Set `OPENCODE_SANDBOX_DEBUG=1` to enable debug-level entries (per-attempt health probes, per-step uncommitted-overlay progress, etc.).

## Debugging

Run opencode in server mode so logs land on stderr you can read:

```sh
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode serve
# in another shell
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode attach http://localhost:4096
```

The host log file is at `~/.local/share/opencode/log/<timestamp>.log`. Grep for `service=vercel-sandbox` to filter.

## Cleanup of orphan sandboxes

When `create` fails partway through (network blip, health-probe timeout, install error, etc.), the sandbox is deliberately left running in your Vercel account so you can inspect it (`tail $HOME/opencode-serve.log` inside, or just read state). The trade-off: it stays in your sandbox quota until you delete it.

Two ways to clean up:

```sh
# Via opencode UI: select the workspace, choose Remove. The plugin's
# `remove()` calls `sandbox.delete()` and is idempotent.

# Or directly via Vercel CLI:
vercel sandbox ls | grep opencode-
vercel sandbox rm <name-or-id>
```

If you see workspaces listed in opencode but the underlying sandbox name doesn't appear in `vercel sandbox ls`, the sandbox was already torn down (e.g., snapshot expired) and Remove will just clear opencode's local record.
