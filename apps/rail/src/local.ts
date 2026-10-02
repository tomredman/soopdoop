// ABOUTME: Server-side. Lets the rail page see whether this machine is paired, and pair it, with no terminal step.
// ABOUTME: Writes the daemon's config (~/.soopdoop/config.json), which the daemon picks up within a second.
import { hostname } from "node:os";
import { configPath, readConfig, writeConfig, type Config } from "@soopdoop/daemon/src/config";
import { originAllowed } from "./token-proxy";

export interface LocalInfo {
  machine: string;
  paired: boolean;
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

// A page on another site that points a DNS name at 127.0.0.1 still sends its own Host; refuse it.
export function hostAllowed(req: Request, railOrigin: string): boolean {
  return req.headers.get("host") === new URL(railOrigin).host;
}

// GET /local
export async function localInfo(req: Request, railOrigin: string, file: string = configPath()): Promise<Response> {
  if (!hostAllowed(req, railOrigin)) return json(403, { error: "Only the rail's own page may ask." });
  const info: LocalInfo = { machine: machineName(), paired: (await currentConfig(file)) !== null };
  return json(200, { ...info });
}

// POST /local/pair { token, replace? }. The Convex URL is this server's own, so a page cannot point the daemon
// anywhere else. Refuses to replace a working pairing unless asked.
export async function pairHere(req: Request, railOrigin: string, convexUrl: string, file: string = configPath()): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"), railOrigin)) {
    return json(403, { error: "Only the rail's own page may pair this machine." });
  }
  const raw: unknown = await req.json().catch(function () {
    return null;
  });
  const token = isRecord(raw) && typeof raw.token === "string" && /^sd_[a-f0-9]{32}$/.test(raw.token) ? raw.token : null;
  if (token === null) return json(400, { error: "Expected a daemon token from subsets.pairDaemon." });
  const existing = await currentConfig(file);
  if (existing !== null && !(isRecord(raw) && raw.replace === true)) {
    return json(409, { error: "This machine is already paired." });
  }
  await writeConfig({ convexUrl, token, privateDirs: existing?.privateDirs ?? [] }, file);
  return json(200, { paired: true });
}
