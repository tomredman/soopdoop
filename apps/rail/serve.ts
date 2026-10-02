// ABOUTME: The rail's local server on 127.0.0.1:47312: serves index.html through Bun's bundler, answers /config.json,
// ABOUTME: forwards the OAuth token exchange the page cannot make itself, and answers /local: pairing, version, updates.
import path from "node:path";
import { currentVersion } from "@soopdoop/daemon/src/update";
import index from "./index.html";
import { DEFAULT_CONVEX_URL } from "./src/config";
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
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`rail v${server.version} on ${ORIGIN}/ · convex ${url}${SERVICE ? " · service" : ""}`);
