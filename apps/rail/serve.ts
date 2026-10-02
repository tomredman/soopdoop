// ABOUTME: The rail's local server on 127.0.0.1:47312: the native app's backend (/app socket, src/agent.ts), the web rail
// ABOUTME: page, /config.json, the OAuth token exchange the page cannot make itself, and /local: pairing, version, updates.
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { currentVersion } from "@soopdoop/daemon/src/update";
import index from "./index.html";
import { createAgent } from "./src/agent";
import { ensureAppToken, parseCommand, upgradeAllowed } from "./src/app-api";
import { DEFAULT_CONVEX_URL } from "./src/config";
import { cleanError } from "./src/format";
import { localInfo, pairHere, settingsHere, updateHere, type LocalServer } from "./src/local";
import { exchange } from "./src/token-proxy";

const PORT = Number(process.env.RAIL_PORT ?? "47312");
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The background service (soopdoop setup) sets this: a built page, no hot reload, no browser console in the log.
// `bun run rail` leaves it unset for working on the rail.
const SERVICE = process.env.SOOPDOOP_SERVICE === "1";

async function convexUrl(): Promise<string> {
  const fromEnv = process.env.CONVEX_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  // A checkout that runs `npx convex dev` has the backend package's .env.local.
  const envFile = Bun.file(path.join(import.meta.dir, "..", "..", "packages", "convex", ".env.local"));
  if (await envFile.exists()) {
    const match = /^CONVEX_URL=(\S+)/m.exec(await envFile.text());
    const url = match?.[1];
    if (url !== undefined) return url;
  }
  // Everyone else uses the shared deployment.
  return DEFAULT_CONVEX_URL;
}

const url = await convexUrl();
const server: LocalServer = {
  railOrigin: ORIGIN,
  convexUrl: url,
  version: await currentVersion(path.join(import.meta.dir, "..", "..")),
  // Only setup's background services come with the updater job that "Update now" starts.
  canUpdate: SERVICE && process.platform === "darwin",
};

// The native app talks to the agent over /app; every connected app gets each new state.
const appToken = await ensureAppToken();
const agent = createAgent(server);
const apps = new Set<ServerWebSocket<unknown>>();
agent.subscribe(function (state) {
  const message = JSON.stringify({ type: "state", state });
  for (const ws of apps) ws.send(message);
});
await agent.start();

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: SERVICE ? false : { hmr: true, console: true },
  routes: {
    "/": index,
    "/config.json": function () {
      return Response.json({ convexUrl: url });
    },
    // Superset's token endpoint sends no CORS headers, so the page asks this server to make the call.
    "/oauth/token": {
      POST: function (req) {
        return exchange(req, ORIGIN);
      },
    },
    "/local": {
      GET: function (req) {
        return localInfo(req, server);
      },
    },
    "/local/pair": {
      POST: function (req) {
        return pairHere(req, server);
      },
    },
    "/local/update": {
      POST: function (req) {
        return updateHere(req, server);
      },
    },
    "/local/settings": {
      POST: function (req) {
        return settingsHere(req, server);
      },
    },
  },
  websocket: {
    open(ws) {
      apps.add(ws);
      ws.send(JSON.stringify({ type: "state", state: agent.state() }));
    },
    async message(ws, raw) {
      const command = parseCommand(String(raw));
      if (command === null) return;
      try {
        const value = await agent.act(command.action, command.args);
        ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, value: value ?? null }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "result", id: command.id, ok: false, error: cleanError(e) }));
      }
    },
    close(ws) {
      apps.delete(ws);
    },
  },
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/app") {
      if (!upgradeAllowed(req, appToken)) return new Response("Forbidden", { status: 403 });
      if (srv.upgrade(req)) return undefined;
      return new Response("Expected a WebSocket", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`rail v${server.version} on ${ORIGIN}/ · convex ${url}${SERVICE ? " · service" : ""}`);
