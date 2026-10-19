// ABOUTME: Tests soopdoop's Grok hooks: its own file in a temporary GROK_HOME's hooks folder, beside Superset's untouched one, the
// ABOUTME: events and the Notification matcher, and the real hook.ts run through the command as Grok runs it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardedHook } from "./hooks";
import { GROK_EVENTS, grokHome, grokHooksInstalled, grokHooksPath, installGrokHooks, uninstallGrokHooks } from "./hooks-grok";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-grok-hooks-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const command = guardedHook("/Users/ada/.bun/bin/bun", "/Users/ada/.soopdoop/app/apps/daemon/src/hook.ts", "grok");

describe("Grok hooks", function () {
  test("live in soopdoop's own file beside Superset's, which stays as it was; uninstalling deletes ours", async function () {
    const home = await tempDir();
    const file = grokHooksPath(home);
    expect(file).toBe(path.join(home, "hooks", "soopdoop.json"));
    const superset = path.join(home, "hooks", "superset-notify.json");
    await mkdir(path.dirname(superset), { recursive: true });
    const theirs = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "SUPERSET_HOOK_HARNESS=grok notify.sh || true" }] }] } }, null, 2);
    await writeFile(superset, theirs);
    expect(await installGrokHooks(command, file)).toBeNull();
    const ours = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(ours.hooks)).toEqual(GROK_EVENTS.map(function (e) { return e.event; }));
    expect(ours.hooks.Notification).toEqual([{ matcher: "^(permission_prompt|elicitation_dialog)$", hooks: [{ type: "command", command: command("Notification"), timeout: 5 }] }]);
    expect(ours.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: command("Stop"), timeout: 5 }] }]);
    expect(await grokHooksInstalled(command, file)).toBe(true);
    // An update installs again: still one entry per event, and no backup of our own file.
    await installGrokHooks(command, file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(ours);
    expect(await Bun.file(`${file}.before-soopdoop`).exists()).toBe(false);
    expect(await uninstallGrokHooks(file)).toBe(true);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await readFile(superset, "utf8")).toBe(theirs);
    expect(grokHome({ GROK_HOME: "/g" }, "/Users/ada")).toBe("/g");
    expect(grokHome({}, "/Users/ada")).toBe("/Users/ada/.grok");
  });

  test("the command runs the real hook.ts as Grok: camelCase payload, the session id from GROK_SESSION_ID, nothing printed", async function () {
    const received: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        received.push(await req.json());
        return Response.json({ context: "soopdoop: crew" });
      },
    });
    try {
      const real = guardedHook(process.execPath, path.join(import.meta.dir, "hook.ts"), "grok")("UserPromptSubmit");
      // What Grok sets on every hook process (its hooks guide), and its payload for a prompt.
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SOOPDOOP_PORT: String(server.port), GROK_SESSION_ID: "g1", GROK_HOOK_EVENT: "user_prompt_submit", GROK_WORKSPACE_ROOT: "/r/vibes", CLAUDE_PROJECT_DIR: "/r/vibes" };
      const proc = Bun.spawn(["sh", "-c", real], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
      proc.stdin.write(JSON.stringify({ hookEventName: "user_prompt_submit", hook_event_name: "UserPromptSubmit", sessionId: "g1", cwd: "/r/vibes", workspaceRoot: "/r/vibes", permissionMode: "default", promptId: "p1", prompt: "fix the bounces" }));
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      // Grok ignores what UserPromptSubmit hooks print, so nothing is.
      expect(await new Response(proc.stdout).text()).toBe("");
      // The prompt goes to the daemon on 127.0.0.1 for heads-ups (Grok gets the HUD card), and stops there.
      expect(received).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "g1", cwd: "/r/vibes", harness: "grok", prompt: "fix the bounces", grokSessionId: "g1" }]);
    } finally {
      server.stop(true);
    }
  });
});
