// ABOUTME: The rail's local server: serves index.html through Bun's bundler with hot reload on 127.0.0.1:47312,
// ABOUTME: answers /config.json with the Convex URL, and forwards the OAuth token exchange the page cannot make itself.
import path from "node:path";
import index from "./index.html";
import { exchange } from "./src/token-proxy";

const PORT = Number(process.env.RAIL_PORT ?? "47312");
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function convexUrl(): Promise<string> {
  const fromEnv = process.env.CONVEX_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  // Fall back to the backend package's .env.local, written by `npx convex dev`.
  const envFile = Bun.file(path.join(import.meta.dir, "..", "..", "packages", "convex", ".env.local"));
  if (await envFile.exists()) {
    const match = /^CONVEX_URL=(\S+)/m.exec(await envFile.text());
    const url = match?.[1];
    if (url !== undefined) return url;
  }
  throw new Error("Set CONVEX_URL, or run `bun run convex` once so packages/convex/.env.local exists.");
}

const url = await convexUrl();

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: { hmr: true, console: true },
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
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`rail on ${ORIGIN}/ · convex ${url}`);
