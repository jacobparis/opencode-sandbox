import type { NetworkPolicy } from "@vercel/sandbox"

/**
 * Curated default egress allowlist for opencode workspaces.
 *
 * Goal: block opportunistic exfiltration (an attacker inside a compromised
 * sandbox POSTing `process.env` to evil.com) without breaking common opencode
 * workflows. We keep TLS end-to-end — no transformers are attached, so the
 * firewall matches on SNI only.
 *
 * Users can replace this entirely with `egressPolicy: "allow-all"` or extend
 * via `extraAllowDomains` if their project's tools reach a domain we missed.
 *
 * Wildcards follow the Vercel Sandbox firewall semantics:
 *   - `*.foo.com` matches any subdomain (not the parent)
 *   - `bar.*.com` matches exactly one middle segment
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  // Git / GitHub
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",

  // OpenCode itself (install script, release tarballs, auth, model catalog)
  "opencode.ai",
  "*.opencode.ai",
  "models.dev",

  // Common package registries (the repo's own dev tooling will likely need these)
  "registry.npmjs.org",
  "registry.bun.sh",
  "registry.yarnpkg.com",
  "pkg.pr.new",

  // OAuth callbacks
  "accounts.google.com",
  "oauth2.googleapis.com",

  // AI providers (broad set — opencode supports many)
  "api.openai.com",
  "api.anthropic.com",
  "api.cohere.com",
  "api.cohere.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.deepseek.com",
  "api.x.ai",
  "api.perplexity.ai",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "*.openai.azure.com",
  "ai-gateway.vercel.sh",
  "api.deepinfra.com",
  "api.githubcopilot.com",
  "copilot-proxy.githubusercontent.com",

  // AWS Bedrock (regional endpoints)
  "bedrock-runtime.*.amazonaws.com",
  "bedrock.*.amazonaws.com",
  "bedrock-agent-runtime.*.amazonaws.com",

  // Vercel platform (the sandbox itself talks to *.vercel.run for its own routing)
  "*.vercel.run",
  "api.vercel.com",
]

export type EgressPolicy = "default" | "allow-all"

export type BuildNetworkPolicyOptions = {
  egressPolicy: EgressPolicy
  extraAllowDomains: string[]
}

export function buildNetworkPolicy(options: BuildNetworkPolicyOptions): NetworkPolicy {
  if (options.egressPolicy === "allow-all") return "allow-all"
  return {
    allow: dedupe([...DEFAULT_ALLOWED_DOMAINS, ...options.extraAllowDomains]),
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items))
}
