import type { Sandbox } from "@vercel/sandbox"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Context } from "./types.js"

/** Where we stage the diff inside the sandbox before applying it. */
const STAGING_DIR = ".opencode-sandbox-staging"
const DIFF_FILE = `${STAGING_DIR}/uncommitted.diff`

/**
 * Overlay the host's uncommitted working-tree state onto the sandbox's
 * freshly-cloned repo. Captures two things on the host:
 *
 *   1. A `git diff` against `origin/<branch>` (binary-safe). This base
 *      matches what the sandbox just cloned, so the patch applies cleanly
 *      even when the host has unpushed commits on top.
 *   2. Untracked files (respecting `.gitignore` via `--exclude-standard`).
 *
 * Both are shipped to the sandbox via `writeFiles`, then `git apply` runs
 * the patch. Anything ignored by `.gitignore` (node_modules, .env.local,
 * etc.) is intentionally not transferred.
 */
export async function applyUncommittedFromHost(
  ctx: Context,
  sandbox: Sandbox,
  branch: string,
): Promise<void> {
  const { $, worktree } = ctx.input

  // Refresh `origin/<branch>` so the diff base lines up with whatever the
  // sandbox just cloned. If fetch fails (offline, no access) we fall back
  // to diffing against host HEAD and warn; the apply may fail on unpushed
  // commits but most cases still work.
  const fetchResult = await $.cwd(worktree)`git fetch origin ${branch} --quiet --no-tags`.nothrow().quiet()
  const diffBase = fetchResult.exitCode === 0 ? `origin/${branch}` : "HEAD"
  if (fetchResult.exitCode !== 0) {
    await ctx.log("warn", "uncommitted: `git fetch origin` failed; diffing against host HEAD", {
      branch,
      exitCode: fetchResult.exitCode,
      stderr: fetchResult.stderr.toString("utf8").slice(0, 300),
    })
  }

  const diffResult = await $.cwd(worktree)`git diff ${diffBase} --binary --no-color`.nothrow().quiet()
  if (diffResult.exitCode !== 0) {
    throw new Error(
      `uncommitted: failed to capture working-tree diff against ${diffBase}: ${diffResult.stderr.toString("utf8").slice(0, 300)}`,
    )
  }
  const diff = diffResult.stdout

  const untrackedResult = await $.cwd(worktree)`git ls-files --others --exclude-standard -z`.nothrow().quiet()
  if (untrackedResult.exitCode !== 0) {
    throw new Error(
      `uncommitted: failed to list untracked files: ${untrackedResult.stderr.toString("utf8").slice(0, 300)}`,
    )
  }
  const untrackedPaths = untrackedResult.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0)

  await ctx.log("info", "uncommitted: applying host working-tree changes to sandbox", {
    diffBase,
    diffBytes: diff.length,
    untrackedCount: untrackedPaths.length,
  })

  const writes: Array<{ path: string; content: Buffer }> = []
  for (const relPath of untrackedPaths) {
    try {
      const content = await readFile(join(worktree, relPath))
      writes.push({ path: relPath, content })
    } catch (err) {
      await ctx.log("warn", "uncommitted: skipping unreadable untracked file", {
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (diff.length > 0) writes.push({ path: DIFF_FILE, content: diff })

  if (writes.length === 0) {
    await ctx.log("info", "uncommitted: nothing to apply (host tree is clean against origin)", { diffBase })
    return
  }

  await sandbox.writeFiles(writes)

  if (diff.length > 0) {
    const apply = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        `cd /vercel/sandbox && git apply --whitespace=nowarn ${DIFF_FILE} && rm -rf ${STAGING_DIR}`,
      ],
    })
    if (apply.exitCode !== 0) {
      const stderr = await apply.stderr()
      throw new Error(
        `uncommitted: \`git apply\` failed in sandbox (exit ${apply.exitCode}):\n${stderr.slice(0, 1000)}`,
      )
    }
  }

  await ctx.log("info", "uncommitted: overlay applied", {
    diffBase,
    files: writes.map((w) => w.path).sort(),
  })
}
