import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeConfig } from "./config";

// Runs the real `soopdoop serve` against a throwaway home and port, the way the background service runs it.
const CLI = path.join(import.meta.dir, "cli.ts");
const PORT = 47391;
const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-serve-"));
const home = path.join(dir, "home");
const proc = Bun.spawn([process.execPath, CLI, "serve"], {
  env: { ...process.env, SOOPDOOP_HOME: home, SOOPDOOP_PORT: String(PORT) },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(async function () {
  proc.kill();
  await proc.exited;
  await rm(dir, { recursive: true, force: true });
});

async function status(): Promise<{ paired: boolean; agents: unknown[] } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    return (await res.json()) as { paired: boolean; agents: unknown[] };
  } catch {
    return null;
  }
}

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const until = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < until) {
    await Bun.sleep(100);
    last = await read();
  }
  return last;
}

describe("soopdoop serve", function () {
  test("starts unpaired, takes hook events, and picks up a pairing without a restart", async function () {
    const before = await eventually(status, function (s) { return s !== null; });
    expect(before?.paired).toBe(false);

    const hook = await fetch(`http://127.0.0.1:${PORT}/hook`, {
      method: "POST",
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/r/vibes" }),
    });
    expect(hook.status).toBe(200);
    expect((await status())?.agents).toHaveLength(1);

    // A web page posting to the daemon carries an Origin; it is refused and changes nothing.
    const fromPage = await fetch(`http://127.0.0.1:${PORT}/hook`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "fake", cwd: "/r/fake" }),
    });
    expect(fromPage.status).toBe(403);
    expect((await status())?.agents).toHaveLength(1);

    // What the rail's /local/pair does. Nothing listens at this Convex URL; reports fail quietly into the log.
    await writeConfig({ convexUrl: "http://127.0.0.1:9", token: "sd_test", privateDirs: [] }, path.join(home, "config.json"));
    const after = await eventually(status, function (s) { return s?.paired === true; });
    expect(after?.paired).toBe(true);
    expect(after?.agents).toHaveLength(1);
  }, 15_000);
});
