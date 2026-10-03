// ABOUTME: Serves the site at http://127.0.0.1:47320/: the page through Bun's bundler with hot reload and public/ as
// ABOUTME: plain files, or with --dist exactly what `bun run build` made (what Cloudflare will serve).
import path from "node:path";
import index from "../index.html";

const root = path.join(import.meta.dir, "..");
const fromDist = Bun.argv.includes("--dist");
const base = path.join(root, fromDist ? "dist" : "public");
const port = Number(process.env.PORT ?? 47320);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: fromDist ? false : { hmr: true, console: true },
  routes: fromDist ? undefined : { "/": index },
  async fetch(req) {
    const url = new URL(req.url);
    const wanted = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.resolve(base, `.${wanted}`);
    if (!file.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
    const found = Bun.file(file);
    if (await found.exists()) return new Response(found);
    const missing = Bun.file(path.join(base, "404.html"));
    return (await missing.exists()) ? new Response(missing, { status: 404 }) : new Response("Not found", { status: 404 });
  },
});
console.log(`soopdoop.com${fromDist ? " (dist)" : ""} on ${server.url}`);
