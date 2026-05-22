import { AccessTokenMissingError, RefreshAccessTokenFailedError, getVercelOidcToken } from "@vercel/oidc"

export class VercelAuthError extends Error {
  override readonly name = "VercelAuthError"
  constructor(message: string, public override cause?: unknown) {
    super(message)
  }
}

/**
 * Verify that a Vercel OIDC token is reachable (via env var or refreshable
 * through the Vercel CLI). Throws a structured error pointing the user at
 * the fix when it isn't.
 */
export async function verifyVercelOidc(): Promise<void> {
  try {
    await getVercelOidcToken()
  } catch (err) {
    if (err instanceof AccessTokenMissingError) {
      throw new VercelAuthError(
        "No Vercel OIDC token available. Run `vercel link` and `vercel env pull` in this project (or sign in with `vercel login`), then retry.",
        err,
      )
    }
    if (err instanceof RefreshAccessTokenFailedError) {
      throw new VercelAuthError(
        "Vercel OIDC token could not be refreshed. Run `vercel login`, then `vercel link` in this project, then retry.",
        err,
      )
    }
    throw new VercelAuthError(
      `Vercel auth failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
}
