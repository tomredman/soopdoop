// ABOUTME: Server-side. What the rail page may ask this machine: is it paired (pair it), which version runs, is a newer
// ABOUTME: release out (update now), and the auto-update setting. Only the rail's own page may call these.
import { hostname } from "node:os";
import { configPath, readConfig, readSettings, settingsPath, writeConfig, writeSettings, type Config } from "@soopdoop/daemon/src/config";
import { startNow, UPDATER_LABEL } from "@soopdoop/daemon/src/service";
import { isNewer, readUpdateState, releasePage, requestUpdate, updateRunning } from "@soopdoop/daemon/src/update";
import { originAllowed } from "./token-proxy";

export interface LocalInfo {
  machine: string;
  // Paired with the deployment this rail uses. A pairing with another deployment does not count.
  paired: boolean;
  version: string;
  latest: string | null;
  newer: boolean;
  releaseUrl: string | null;
  autoUpdate: boolean;
  // Whether this rail can update itself (the background updater exists), or the hacker must use the terminal.
  canUpdate: boolean;
  updating: boolean;
  updateError: string | null;
}

// What the server knows about itself, fixed at start.
export interface LocalServer {
  railOrigin: string;
  convexUrl: string;
  version: string;
  canUpdate: boolean;
  configFile?: string;
  settingsFile?: string;
}

// "MBP16.local" → "mbp16". Only the hacker sees machine names (subsets.mine), never friends.
export function machineName(host: string = hostname()): string {
  const short = host
    .replace(/\.local$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return short === "" ? "this-machine" : short;
}

async function currentConfig(file: string): Promise<Config | null> {
  try {
    return await readConfig(file);
  } catch {
    // An unreadable config is as good as none: pairing again replaces it.
    return null;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function body(req: Request): Promise<unknown> {
  return await req.json().catch(function () {
    return null;
  });
}

// A page on another site that points a DNS name at 127.0.0.1 still sends its own Host; refuse it.
export function hostAllowed(req: Request, railOrigin: string): boolean {
  return req.headers.get("host") === new URL(railOrigin).host;
}

// What this machine says about itself: pairing, version, updates. For GET /local and the app's state.
export async function readLocalInfo(server: LocalServer): Promise<LocalInfo> {
  const [config, settings, state, updating] = await Promise.all([
    currentConfig(server.configFile ?? configPath()),
    readSettings(server.settingsFile ?? settingsPath()),
    readUpdateState(),
    updateRunning(),
  ]);
  const latest = state.latest ?? null;
  const info: LocalInfo = {
    machine: machineName(),
    paired: config !== null && config.convexUrl === server.convexUrl,
    version: server.version,
    latest,
    newer: isNewer(latest, server.version),
    releaseUrl: latest === null ? null : releasePage(latest),
    autoUpdate: settings.autoUpdate,
    canUpdate: server.canUpdate,
    updating,
    updateError: state.error ?? null,
  };
  return info;
}

// GET /local
export async function localInfo(req: Request, server: LocalServer): Promise<Response> {
  if (!hostAllowed(req, server.railOrigin)) return json(403, { error: "Only the rail's own page may ask." });
  return json(200, { ...(await readLocalInfo(server)) });
}

// POST /local/pair { token, replace? }. The Convex URL is this server's own, so a page cannot point the daemon
// anywhere else. Refuses to replace a working pairing with this deployment unless asked; a pairing with another
// deployment (the rail moved from dev to production) is replaced.
export async function pairHere(req: Request, server: LocalServer): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"), server.railOrigin)) {
    return json(403, { error: "Only the rail's own page may pair this machine." });
  }
  const raw = await body(req);
  const token = isRecord(raw) && typeof raw.token === "string" && /^sd_[a-f0-9]{32}$/.test(raw.token) ? raw.token : null;
  if (token === null) return json(400, { error: "Expected a daemon token from subsets.pairDaemon." });
  const file = server.configFile ?? configPath();
  const existing = await currentConfig(file);
  const sameDeployment = existing !== null && existing.convexUrl === server.convexUrl;
  if (sameDeployment && !(isRecord(raw) && raw.replace === true)) {
    return json(409, { error: "This machine is already paired." });
  }
  await writeConfig({ convexUrl: server.convexUrl, token, privateDirs: existing?.privateDirs ?? [] }, file);
  return json(200, { paired: true });
}

// POST /local/update. Asks the background updater to install the newest release now, even with auto-update off.
// The updater restarts this server, so the page polls /local until the version changes.
export async function updateHere(req: Request, server: LocalServer, start: (label: string) => Promise<void> = startNow): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"), server.railOrigin)) {
    return json(403, { error: "Only the rail's own page may update soopdoop." });
  }
  if (!server.canUpdate) return json(409, { error: "This rail was not started by soopdoop setup. Run `soopdoop update` in Terminal." });
  await requestUpdate();
  try {
    await start(UPDATER_LABEL);
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
  return json(202, { started: true });
}

// POST /local/settings { autoUpdate }
export async function settingsHere(req: Request, server: LocalServer): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"), server.railOrigin)) {
    return json(403, { error: "Only the rail's own page may change settings." });
  }
  const raw = await body(req);
  if (!isRecord(raw) || typeof raw.autoUpdate !== "boolean") return json(400, { error: "Expected { autoUpdate: true | false }." });
  await writeSettings({ autoUpdate: raw.autoUpdate }, server.settingsFile ?? settingsPath());
  return json(200, { autoUpdate: raw.autoUpdate });
}
