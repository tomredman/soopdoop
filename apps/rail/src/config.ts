// ABOUTME: Fixed facts the rail needs: the Superset OAuth client it registered, its own origin, how to find Convex,
// ABOUTME: and where invitees get the code. The client id is public (PKCE, no secret), bound to http://127.0.0.1:47312/.

export const SUPERSET_ISSUER = "https://api.superset.sh";
export const SUPERSET_CLIENT_ID = "gWmZSWArIkMusxcjDPhyXqKfhSiDBced";
export const RAIL_PORT = 47312;
export const RAIL_ORIGIN = `http://127.0.0.1:${RAIL_PORT}`;
export const REDIRECT_URI = `${RAIL_ORIGIN}/`;
export const SCOPES = "openid profile email offline_access";

// The shared dev deployment everyone in the trial uses (Convex team vibes, project soopdoop). Not a secret: it only
// names the backend, and every public function behind it checks a Superset sign-in or a daemon token.
export const DEFAULT_CONVEX_URL = "https://nautical-dalmatian-541.convex.cloud";
// Where an invitee gets the code (a private repository: they need read access), and where setup puts it.
export const REPO_URL = "https://github.com/tomredman/soopdoop.git";
export const INSTALL_DIR = "~/.soopdoop/app";

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
