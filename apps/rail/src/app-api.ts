// ABOUTME: Server-side. The native app's socket (/app): checks the app token, pushes the agent's state on every change, and
// ABOUTME: runs the actions the app sends ({ id, action, args } → { id, ok, value | error }). Browsers are refused.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { soopdoopHome } from "@soopdoop/daemon/src/config";

export function appTokenPath(home: string = soopdoopHome()): string {
  return path.join(home, "app-token");
}

// The app proves it runs as this user by reading this file; only the owner can.
export async function ensureAppToken(file: string = appTokenPath()): Promise<string> {
  const f = Bun.file(file);
  if (await f.exists()) {
    const token = (await f.text()).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, token + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

// A browser always sends Origin on a WebSocket handshake, so any page could otherwise reach 127.0.0.1. The app sends
// none, and carries the token.
export function upgradeAllowed(req: Request, token: string): boolean {
  if (req.headers.get("origin") !== null) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${token}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export interface Command {
  id: number;
  action: string;
  args: unknown;
}

export function parseCommand(raw: string): Command | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  if (!("id" in message) || !("action" in message)) return null;
  const { id, action } = message;
  if (typeof id !== "number" || typeof action !== "string") return null;
  return { id, action, args: "args" in message ? message.args : undefined };
}
