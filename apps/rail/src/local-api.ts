// ABOUTME: The page's side of /local: what this machine's rail server says about pairing, version and updates.
// ABOUTME: readLocal gives null when the page is not served by a soopdoop rail server (a static build, or the server is down).

export interface Local {
  machine: string;
  paired: boolean;
  version: string;
  latest: string | null;
  newer: boolean;
  releaseUrl: string | null;
  autoUpdate: boolean;
  canUpdate: boolean;
  updating: boolean;
  updateError: string | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function stringOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

export function parseLocal(raw: unknown): Local | null {
  if (!isRecord(raw)) return null;
  const { machine, paired, version, newer, autoUpdate, canUpdate, updating } = raw;
  if (typeof machine !== "string" || typeof paired !== "boolean" || typeof version !== "string") return null;
  return {
    machine,
    paired,
    version,
    latest: stringOrNull(raw.latest),
    newer: newer === true,
    releaseUrl: stringOrNull(raw.releaseUrl),
    autoUpdate: autoUpdate !== false,
    canUpdate: canUpdate === true,
    updating: updating === true,
    updateError: stringOrNull(raw.updateError),
  };
}

export async function readLocal(): Promise<Local | null> {
  try {
    const res = await fetch("/local", { cache: "no-store" });
    if (!res.ok) return null;
    return parseLocal(await res.json());
  } catch {
    return null;
  }
}

// POSTs JSON to the rail server. `error` carries the server's own message when it gives one.
export async function postLocal(path: string, body: unknown): Promise<{ ok: boolean; status: number; error: string | null }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer: unknown = await res.json().catch(function () { return null; });
    const error = isRecord(answer) && typeof answer.error === "string" ? answer.error : null;
    return { ok: res.ok, status: res.status, error: res.ok ? null : (error ?? `the rail server answered ${res.status}`) };
  } catch {
    return { ok: false, status: 0, error: "Could not reach this machine's rail server." };
  }
}
