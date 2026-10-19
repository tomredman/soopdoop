// ABOUTME: Builds soopdoop.com into dist/: Bun bundles the pages (scripts and styles, minified and hashed), then public/ is
// ABOUTME: copied as it is (fonts, icons, the social card, 404 page, and Cloudflare's _headers and _redirects).
import { cp, rm } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.join(root, "dist");
// invite.html is the page invite links open: soopdoop.com/invite#<code>. Cloudflare serves each page without its .html
// too (/teams, /privacy, /terms).
const pages = ["index.html", "invite.html", "teams.html", "privacy.html", "terms.html"];

await rm(dist, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: pages.map(function (page) { return path.join(root, page); }),
  outdir: dist,
  minify: true,
  // Root paths (/fonts, /favicon.svg) are files in public/, served as they are: leave them alone.
  external: ["/*"],
  naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await cp(path.join(root, "public"), dist, { recursive: true });
for (const out of result.outputs) console.log(`${path.relative(root, out.path).padEnd(40)} ${(out.size / 1024).toFixed(1)} KB`);
console.log("dist/ is ready. `bun run preview` serves it; `bun run deploy` ships it.");
