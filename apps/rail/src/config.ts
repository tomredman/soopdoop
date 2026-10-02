// ABOUTME: Fixed facts the rail needs: the Superset OAuth client it registered, its own origin, how to find Convex,
// ABOUTME: and where installs and releases live. The client id is public (PKCE, no secret), bound to http://127.0.0.1:47312/.

export const SUPERSET_ISSUER = "https://api.superset.sh";
export const SUPERSET_CLIENT_ID = "gWmZSWArIkMusxcjDPhyXqKfhSiDBced";
export const RAIL_PORT = 47312;
export const RAIL_ORIGIN = `http://127.0.0.1:${RAIL_PORT}`;
export const REDIRECT_URI = `${RAIL_ORIGIN}/`;
export const SCOPES = "openid profile email offline_access";

// The production deployment every install uses (Convex team vibes, project soopdoop). Only `bun run release` deploys
// to it. Not a secret: it only names the backend, and every public function checks a Superset sign-in or a daemon token.
export const DEFAULT_CONVEX_URL = "https://fleet-skunk-723.convex.cloud";
// The installer puts the newest release in ~/.soopdoop/app and runs its setup.
export const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/tomredman/soopdoop/main/install.sh";
export const RELEASES_URL = "https://github.com/tomredman/soopdoop/releases";

const URL_KEY = "soopdoop.convexUrl";

export interface RailConfig {
  convexUrl: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Dev: serve.ts answers /config.json. A static build remembers the URL from a ?convex= query once.
export async function loadConfig(): Promise<RailConfig> {
  const fromQuery = new URL(location.href).searchParams.get("convex");
  if (fromQuery !== null && fromQuery !== "") {
    localStorage.setItem(URL_KEY, fromQuery);
    return { convexUrl: fromQuery };
  }
  try {
    const res = await fetch("/config.json");
    if (res.ok) {
      const raw: unknown = await res.json();
      if (isRecord(raw) && typeof raw.convexUrl === "string") return { convexUrl: raw.convexUrl };
    }
  } catch {
    // A static build has no dev server behind it.
  }
  const remembered = localStorage.getItem(URL_KEY);
  if (remembered !== null && remembered !== "") return { convexUrl: remembered };
  throw new Error("No Convex deployment URL. Run `bun run rail` in the repo, or open the rail once with ?convex=https://<deployment>.convex.cloud");
}
