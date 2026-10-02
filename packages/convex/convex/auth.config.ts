// ABOUTME: Tells Convex which sign-in tokens to trust. Phase 1 trusts Superset's OpenID Connect ID tokens
// ABOUTME: minted for the soopdoop OAuth client (public client, PKCE). The client id is a deployment env var.

// This file runs in Convex's config loader (Node), not in the function runtime, so `process` exists here.
declare const process: { env: Record<string, string | undefined> };

const clientId = process.env.SUPERSET_CLIENT_ID;
if (clientId === undefined) {
  throw new Error("Set SUPERSET_CLIENT_ID on the deployment: npx convex env set SUPERSET_CLIENT_ID <id>");
}

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: clientId,
      issuer: "https://api.superset.sh",
      jwks: "https://api.superset.sh/api/auth/jwks",
      algorithm: "RS256",
    },
  ],
};
