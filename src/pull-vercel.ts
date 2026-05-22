import type { Sandbox } from "@vercel/sandbox"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Context, VercelEnvTarget } from "./types.js"

/**
 * Mirror Vercel project artifacts from the host into the sandbox so dev
 * servers, build scripts, and any sandbox-side `vercel ...` invocations see
 * the same project link, env, and microfrontends config the user has
 * locally. We deliberately don't parse or transform any of these files \u2014
 * byte-for-byte passthrough.
 *
 * The host's `vercel pull` and `vercel microfrontends pull` mutate
 * `<worktree>/.vercel/` and `<worktree>/microfrontends.json`. Those paths
 * are auto-managed by Vercel's tooling (gitignored or sync-targets), so
 * the mutation is the same thing the user does when they run the CLI by
 * hand.
 *
 * Fails open at every step: any failed pull or missing artifact is logged
 * as a warning and skipped; the sandbox still gets created.
 */
export async function pullVercel(ctx: Context, sandbox: Sandbox, target: VercelEnvTarget): Promise<void> {
  const { $, worktree } = ctx.input

  // 1. `vercel pull` — fills <worktree>/.vercel/ with project link + env file
  const pullResult = await $.cwd(worktree)`vercel pull --environment=${target} --yes`.nothrow().quiet()
  if (pullResult.exitCode !== 0) {
    await ctx.log("warn", "create: `vercel pull` failed; sandbox will start without project sync", {
      target,
      exitCode: pullResult.exitCode,
      stderr: pullResult.stderr.toString("utf8").slice(0, 400),
    })
    return
  }

  // 2. `vercel microfrontends pull` — only when the project uses microfrontends.
  //    Detection signal: presence of microfrontends.json (canonical) or the
  //    @vercel/microfrontends package in dependencies.
  if (await projectUsesMicrofrontends(worktree)) {
    const mfResult = await $.cwd(worktree)`vercel microfrontends pull --yes`.nothrow().quiet()
    if (mfResult.exitCode !== 0) {
      await ctx.log("warn", "create: `vercel microfrontends pull` failed; continuing without microfrontends config", {
        exitCode: mfResult.exitCode,
        stderr: mfResult.stderr.toString("utf8").slice(0, 400),
      })
    }
  }

  // 3. Mirror everything under <worktree>/.vercel/ into <sandbox>/.vercel/
  const dotVercelFiles = await readFilesUnder(join(worktree, ".vercel"))
  // 4. Mirror root-level microfrontends.json (older config location) if present
  const microfrontendsAtRoot = await readFileIfExists(join(worktree, "microfrontends.json"))

  const writes: Array<{ path: string; content: Buffer }> = []
  for (const { relativePath, content } of dotVercelFiles) {
    writes.push({ path: `.vercel/${relativePath}`, content })
  }
  if (microfrontendsAtRoot) {
    writes.push({ path: "microfrontends.json", content: microfrontendsAtRoot })
  }
  if (writes.length === 0) {
    await ctx.log("warn", "create: `vercel pull` succeeded but produced no files to mirror", { target })
    return
  }

  await sandbox.writeFiles(writes)
  await ctx.log("info", "create: mirrored Vercel project artifacts into sandbox", {
    target,
    files: writes.map((w) => w.path).sort(),
  })
}

async function projectUsesMicrofrontends(worktree: string): Promise<boolean> {
  if (existsSync(join(worktree, "microfrontends.json"))) return true
  if (existsSync(join(worktree, ".vercel", "microfrontends.json"))) return true
  try {
    const pkg = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"))
    if (typeof pkg !== "object" || pkg === null) return false
    const deps = { ...(pkg as { dependencies?: Record<string, string> }).dependencies }
    const devDeps = { ...(pkg as { devDependencies?: Record<string, string> }).devDependencies }
    return "@vercel/microfrontends" in deps || "@vercel/microfrontends" in devDeps
  } catch {
    return false
  }
}

type RelativeFile = { relativePath: string; content: Buffer }

async function readFilesUnder(dir: string): Promise<RelativeFile[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files: RelativeFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath, entry.name)
    const content = await readFile(absolute)
    files.push({ relativePath: relative(dir, absolute), content })
  }
  return files
}

async function readFileIfExists(path: string): Promise<Buffer | undefined> {
  if (!existsSync(path)) return undefined
  return readFile(path)
}
