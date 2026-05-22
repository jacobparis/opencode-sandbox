import { describe, expect, test } from "bun:test"
import { GithubAuthError, normalizeGitOriginToHttps } from "../src/auth/github.js"
import { removePluginSpec } from "../src/create.js"
import { buildServeCommand } from "../src/runtime.js"
import { makeSandboxName } from "../src/configure.js"
import { buildNetworkPolicy } from "../src/network-policy.js"
import { parseOptions } from "../src/options.js"
import { decodeExtra, type WorkspaceExtra } from "../src/types.js"
import { isSandboxNotFoundError } from "../src/vercel.js"

describe("normalizeGitOriginToHttps", () => {
  test("converts SSH short form", () => {
    expect(normalizeGitOriginToHttps("git@github.com:foo/bar.git")).toEqual({
      httpsUrl: "https://github.com/foo/bar.git",
      host: "github.com",
      owner: "foo",
      repo: "bar",
    })
  })

  test("converts SSH short form without .git", () => {
    expect(normalizeGitOriginToHttps("git@github.com:foo/bar")).toEqual({
      httpsUrl: "https://github.com/foo/bar.git",
      host: "github.com",
      owner: "foo",
      repo: "bar",
    })
  })

  test("converts ssh:// protocol", () => {
    expect(normalizeGitOriginToHttps("ssh://git@github.com/foo/bar.git")).toEqual({
      httpsUrl: "https://github.com/foo/bar.git",
      host: "github.com",
      owner: "foo",
      repo: "bar",
    })
  })

  test("passes HTTPS through, adding .git", () => {
    expect(normalizeGitOriginToHttps("https://github.com/foo/bar")).toEqual({
      httpsUrl: "https://github.com/foo/bar.git",
      host: "github.com",
      owner: "foo",
      repo: "bar",
    })
  })

  test("preserves multi-segment repo paths", () => {
    expect(normalizeGitOriginToHttps("https://gitlab.com/group/sub/project.git")).toEqual({
      httpsUrl: "https://gitlab.com/group/sub/project.git",
      host: "gitlab.com",
      owner: "group",
      repo: "sub/project",
    })
  })

  test("rejects unsupported scheme", () => {
    expect(() => normalizeGitOriginToHttps("file:///tmp/repo")).toThrow(GithubAuthError)
  })
})

describe("parseOptions", () => {
  const defaults = {
    githubToken: undefined,
    vcpus: 2,
    runtime: "node24",
    snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
    uncommitted: "refuse",
    egressPolicy: "default",
    extraAllowDomains: [],
    sessionTimeoutMs: 45 * 60 * 1000,
    heartbeatIntervalMs: 5 * 60 * 1000,
    heartbeatExtendMs: 15 * 60 * 1000,
    opencodeVersion: undefined,
    extraPorts: [3000, 5173, 4321, 8000],
    pullVercel: true,
    vercelEnvTarget: "development",
  } as const

  test("returns defaults when nothing passed", () => {
    expect(parseOptions(undefined)).toEqual(defaults)
  })

  test("accepts known fields", () => {
    expect(
      parseOptions({
        githubToken: "ghp_x",
        vcpus: 4,
        runtime: "node26",
        snapshotExpiration: 1000,
        uncommitted: "ignore",
        egressPolicy: "allow-all",
        extraAllowDomains: ["api.example.com", "extra.test"],
        sessionTimeoutMs: 60_000,
        heartbeatIntervalMs: 10_000,
        heartbeatExtendMs: 30_000,
        opencodeVersion: "1.15.5",
        extraPorts: [9999, 4000],
        pullVercel: false,
        vercelEnvTarget: "preview",
      }),
    ).toEqual({
      githubToken: "ghp_x",
      vcpus: 4,
      runtime: "node26",
      snapshotExpiration: 1000,
      uncommitted: "ignore",
      egressPolicy: "allow-all",
      extraAllowDomains: ["api.example.com", "extra.test"],
      sessionTimeoutMs: 60_000,
      heartbeatIntervalMs: 10_000,
      heartbeatExtendMs: 30_000,
      opencodeVersion: "1.15.5",
      extraPorts: [9999, 4000],
      pullVercel: false,
      vercelEnvTarget: "preview",
    })
  })

  test("clamps sessionTimeoutMs to Vercel SDK ceiling", () => {
    // Vercel's hard ceiling is 18_000_000ms, minus 30s buffer = 17_970_000
    expect(parseOptions({ sessionTimeoutMs: 30_000_000 }).sessionTimeoutMs).toBe(17_970_000)
    expect(parseOptions({ sessionTimeoutMs: 60_000 }).sessionTimeoutMs).toBe(60_000)
  })

  test("rejects malformed extraPorts entries", () => {
    expect(parseOptions({ extraPorts: [3000, "not-a-number", -1, 5173, 0, 4321] }).extraPorts).toEqual([3000, 5173, 4321])
  })

  test("falls back to defaults for invalid scalars and arrays", () => {
    // Wrong types, invalid enum values, empty/whitespace strings, and a
    // non-array where an array is expected should all be ignored.
    expect(
      parseOptions({
        githubToken: "   ",
        runtime: "",
        vcpus: "no" as unknown as number,
        uncommitted: "banana",
        egressPolicy: "looose",
        extraAllowDomains: "not-an-array" as unknown as string[],
      }),
    ).toEqual(defaults)
  })

  test("filters non-string entries from extraAllowDomains", () => {
    expect(
      parseOptions({
        extraAllowDomains: ["valid.com", "", "   ", 42 as unknown as string, "other.com"],
      }).extraAllowDomains,
    ).toEqual(["valid.com", "other.com"])
  })
})

describe("buildNetworkPolicy", () => {
  test("returns allow-all when egressPolicy is allow-all", () => {
    expect(buildNetworkPolicy({ egressPolicy: "allow-all", extraAllowDomains: ["x.com"] })).toBe("allow-all")
  })

  test("merges the default allowlist with extras and dedupes", () => {
    const policy = buildNetworkPolicy({
      egressPolicy: "default",
      extraAllowDomains: ["api.example.com", "github.com"],
    })
    if (typeof policy === "string") throw new Error("expected object policy")
    const allow = policy.allow as string[]
    // Default list is non-trivial and included (sentinel check, not full equality).
    expect(allow).toContain("github.com")
    expect(allow.length).toBeGreaterThan(5)
    // Extras are appended.
    expect(allow).toContain("api.example.com")
    // Duplicates between defaults and extras collapse.
    expect(allow.filter((d) => d === "github.com").length).toBe(1)
  })
})

describe("decodeExtra", () => {
  const valid: WorkspaceExtra = {
    sandboxName: "opencode-wrk-abc",
    serverPassword: "pw",
    port: 4096,
    gitUrl: "https://github.com/foo/bar.git",
    gitRef: "main",
    opencodeVersion: "1.4.11",
  }

  test("decodes a valid object", () => {
    expect(decodeExtra(valid)).toEqual(valid)
  })

  test("includes includeUncommitted when set to true", () => {
    expect(decodeExtra({ ...valid, includeUncommitted: true })).toEqual({
      ...valid,
      includeUncommitted: true,
    })
  })

  test("omits includeUncommitted when not strictly true", () => {
    expect(decodeExtra({ ...valid, includeUncommitted: false })).toEqual(valid)
    expect(decodeExtra({ ...valid, includeUncommitted: undefined })).toEqual(valid)
  })

  test("rejects null", () => {
    expect(() => decodeExtra(null)).toThrow(/missing or not an object/)
  })

  test("rejects missing field", () => {
    const { gitRef, ...rest } = valid
    void gitRef
    expect(() => decodeExtra(rest)).toThrow(/extra\.gitRef/)
  })

  test("rejects empty string", () => {
    expect(() => decodeExtra({ ...valid, gitRef: "" })).toThrow(/extra\.gitRef/)
  })

  test("rejects non-number port", () => {
    expect(() => decodeExtra({ ...valid, port: "4096" })).toThrow(/extra\.port/)
  })
})

describe("makeSandboxName", () => {
  test("appends a workspaceId suffix so two workspaces with the same slug don't collide", () => {
    // Regression: opencode's random slugs can collide, especially when
    // an orphan sandbox from a previously-failed workspace still holds
    // the slug-only name. The id suffix makes every name unique.
    expect(makeSandboxName("silent-harbor", "wrk_e4c9211ae001dkUmBwgLp9XcJw")).toBe(
      "opencode-silent-harbor-p9xcjw",
    )
    expect(makeSandboxName("silent-harbor", "wrk_e50a35974001X5WgdGCyqCcWkS")).toBe(
      "opencode-silent-harbor-qccwks",
    )
  })

  test("uses the workspace slug when present, with id suffix", () => {
    expect(makeSandboxName("quiet-wizard", "wrk_abc123")).toBe("opencode-quiet-wizard-abc123")
  })

  test("normalises mixed case and stray whitespace", () => {
    expect(makeSandboxName("  Stellar Canyon  ", "wrk_abc123")).toBe("opencode-stellar-canyon-abc123")
  })

  test("collapses unsupported characters into a single hyphen", () => {
    expect(makeSandboxName("brave_planet!!", "wrk_abc123")).toBe("opencode-brave-planet-abc123")
  })

  test("falls back to the workspace id when the slug is empty or too short", () => {
    expect(makeSandboxName("", "wrk_e4228fe94001")).toBe("opencode-wrk-e4228fe94001")
    expect(makeSandboxName("ab", "wrk_e4228fe94001")).toBe("opencode-wrk-e4228fe94001")
    expect(makeSandboxName(undefined, "wrk_e4228fe94001")).toBe("opencode-wrk-e4228fe94001")
  })
})

describe("buildServeCommand", () => {
  test("binds to 0.0.0.0 on the given port, cds to the repo, backgrounds with nohup", () => {
    const cmd = buildServeCommand(4096)
    expect(cmd).toContain("--hostname 0.0.0.0")
    expect(cmd).toContain("--port 4096")
    expect(cmd).toContain("cd /vercel/sandbox")
    expect(cmd).toContain("nohup ")
    expect(cmd.trimEnd().endsWith("&")).toBe(true)
  })
})

describe("removePluginSpec", () => {
  const host = "/Users/jacobparis/Projects/opencode-sandbox/dist/index.js"

  test("drops a tuple entry whose spec matches the host path", () => {
    const input = JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [[host, { uncommitted: "include", opencodeVersion: "1.15.5" }], "opencode-other"],
        mcp: { foo: { type: "remote", url: "https://x" } },
      },
      null,
      2,
    )
    const out = removePluginSpec(input, host)
    expect(out).toBeDefined()
    const parsed = JSON.parse(out!)
    expect(parsed.plugin).toEqual(["opencode-other"])
    expect(parsed.mcp.foo.url).toBe("https://x")
  })

  test("drops a bare string entry matching the host path", () => {
    const input = JSON.stringify({ plugin: [host, "another-plugin"] })
    const parsed = JSON.parse(removePluginSpec(input, host)!)
    expect(parsed.plugin).toEqual(["another-plugin"])
  })

  test("removes the plugin field entirely when it becomes empty", () => {
    const input = JSON.stringify({ plugin: [host] })
    const parsed = JSON.parse(removePluginSpec(input, host)!)
    expect("plugin" in parsed).toBe(false)
  })

  test("returns undefined when no entry matches", () => {
    const input = JSON.stringify({ plugin: ["opencode-other"] })
    expect(removePluginSpec(input, host)).toBeUndefined()
  })

  test("returns undefined when there is no plugin array at all", () => {
    expect(removePluginSpec(JSON.stringify({ mcp: {} }), host)).toBeUndefined()
  })

  test("handles jsonc with comments and trailing commas", () => {
    const input = `{
  // top-level comment
  "plugin": [
    [
      "${host}",
      {
        /* options
           span multiple lines */
        "uncommitted": "include",
      },
    ],
  ],
}
`
    const parsed = JSON.parse(removePluginSpec(input, host)!)
    expect("plugin" in parsed).toBe(false)
  })

  test("does not strip an unrelated absolute path that happens to start similarly", () => {
    const other = "/Users/jacobparis/Projects/opencode-sandbox/dist/index.js.backup"
    const input = JSON.stringify({ plugin: [other] })
    expect(removePluginSpec(input, host)).toBeUndefined()
  })
})



describe("isSandboxNotFoundError", () => {
  test("detects HTTP status 404", () => {
    expect(isSandboxNotFoundError({ status: 404 })).toBe(true)
  })

  test("detects code 'not_found'", () => {
    expect(isSandboxNotFoundError({ code: "not_found" })).toBe(true)
  })

  test("detects message matching", () => {
    expect(isSandboxNotFoundError(new Error("sandbox not found"))).toBe(true)
    expect(isSandboxNotFoundError(new Error("not-found"))).toBe(true)
  })

  test("returns false for unrelated errors", () => {
    expect(isSandboxNotFoundError(new Error("boom"))).toBe(false)
    expect(isSandboxNotFoundError(undefined)).toBe(false)
    expect(isSandboxNotFoundError("string")).toBe(false)
  })
})
