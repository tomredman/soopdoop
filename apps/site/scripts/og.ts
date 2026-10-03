// ABOUTME: Renders og/og.html to public/og.png (the 1200×630 social card) and og/icon.html to public/apple-touch-icon.png
// ABOUTME: with headless Chrome. Set CHROME to its path if it is not in /Applications. Run it after changing either page.
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The pages load /fonts/… like the site does, so serve og/ and public/ together.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const base = url.pathname.startsWith("/og/") ? root : path.join(root, "public");
    const file = path.resolve(base, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    const found = Bun.file(file);
    return (await found.exists()) ? new Response(found) : new Response("Not found", { status: 404 });
  },
});

async function shoot(page: string, out: string, width: number, height: number): Promise<void> {
  const target = path.join(root, "public", out);
  const proc = Bun.spawn([
    chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${width},${height}`, "--virtual-time-budget=4000", `--screenshot=${target}`, `${server.url}og/${page}`,
  ], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`Chrome could not render ${page}: ${await new Response(proc.stderr).text()}`);
  console.log(`public/${out} · ${(Bun.file(target).size / 1024).toFixed(0)} KB`);
}

try {
  await shoot("og.html", "og.png", 1200, 630);
  await shoot("icon.html", "apple-touch-icon.png", 180, 180);
} finally {
  void server.stop(true);
}
