// ABOUTME: Tests soopdoop's Codex hooks: the exact command text and timeouts (Codex trusts a hash of them, so they are pinned),
// ABOUTME: installing beside Superset's hooks in a temporary CODEX_HOME, and the real hook.ts run through that command.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardedHook } from "./hooks";
import { CODEX_EVENTS, codexHome, codexHooks, codexHooksInstalled, codexHooksPath, installCodexHooks, uninstallCodexHooks } from "./hooks-codex";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-codex-hooks-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const HOOK = "/Users/ada/.soopdoop/app/apps/daemon/src/hook.ts";
const command = guardedHook("/Users/ada/.bun/bin/bun", HOOK, "codex");

// The hooks Superset writes into ~/.codex/hooks.json, in its shape.
const SUPERSET = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "[ -n \"$SUPERSET_HOME_DIR\" ] && [ -x \"$SUPERSET_HOME_DIR/hooks/notify.sh\" ] && SUPERSET_HOOK_HARNESS=codex \"$SUPERSET_HOME_DIR/hooks/notify.sh\" || true" }] }],
    PreToolUse: [{ matcher: "^request_user_input$", hooks: [{ type: "command", command: "[ -n \"$SUPERSET_HOME_DIR\" ] && SUPERSET_HOOK_HARNESS=codex \"$SUPERSET_HOME_DIR/hooks/notify.sh\" || true" }] }],
  },
};

describe("Codex hooks", function () {
  test("the command names its harness inline and never changes: Codex trusts a hash of it", function () {
    expect(command("Stop")).toBe("[ -f '/Users/ada/.soopdoop/app/apps/daemon/src/hook.ts' ] && SOOPDOOP_HARNESS=codex '/Users/ada/.bun/bin/bun' '/Users/ada/.soopdoop/app/apps/daemon/src/hook.ts' Stop || true");
    // Claude Code's command stays as it always was.
    expect(guardedHook("/b/bun", "/a/hook.ts")("Stop")).toBe("[ -f '/a/hook.ts' ] && '/b/bun' '/a/hook.ts' Stop || true");
    expect(CODEX_EVENTS).toEqual([
      { event: "SessionStart", timeout: 5 },
      { event: "UserPromptSubmit", timeout: 5 },
      { event: "PreToolUse", timeout: 5 },
      { event: "PermissionRequest", timeout: 5 },
      { event: "Stop", timeout: 5 },
      { event: "Interrupt", timeout: 3 },
      { event: "SessionEnd", timeout: 3 },
    ]);
  });

  test("installs beside Superset's hooks after saving the old file, and uninstalls only ours", async function () {
    const home = await tempDir();
    const file = codexHooksPath(home);
    expect(file).toBe(path.join(home, "hooks.json"));
    await writeFile(file, JSON.stringify(SUPERSET, null, 2));
    expect(await codexHooksInstalled(command, file)).toBe(false);
    expect(await installCodexHooks(command, file)).toBe(`${file}.before-soopdoop`);
    const installed = JSON.parse(await readFile(file, "utf8"));
    expect(installed.hooks.SessionStart[0]).toEqual(SUPERSET.hooks.SessionStart[0]);
    expect(installed.hooks.PreToolUse[0]).toEqual(SUPERSET.hooks.PreToolUse[0]);
    expect(installed.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command: command("SessionEnd"), timeout: 3 }] }]);
    expect(await codexHooksInstalled(command, file)).toBe(true);
    // Every event of ours is there, with our command.
    for (const hook of codexHooks(command)) {
      const commands = installed.hooks[hook.event].flatMap(function (g: { hooks: { command: string }[] }) { return g.hooks.map(function (h) { return h.command; }); });
      expect(commands).toContain(command(hook.event));
    }
    expect(await uninstallCodexHooks(file)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(SUPERSET);
    expect(codexHome({ CODEX_HOME: "/x" }, "/Users/ada")).toBe("/x");
    expect(codexHome({}, "/Users/ada")).toBe("/Users/ada/.codex");
  });

  test("the command runs the real hook.ts as Codex, and is quiet and successful when hook.ts is gone", async function () {
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
      const real = guardedHook(process.execPath, path.join(import.meta.dir, "hook.ts"), "codex")("SessionStart");
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SOOPDOOP_PORT: String(server.port) };
      const proc = Bun.spawn(["sh", "-c", real], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
      proc.stdin.write(JSON.stringify({ session_id: "c1", cwd: "/r/vibes", transcript_path: null, hook_event_name: "SessionStart", model: "gpt-6.1-sol", source: "startup" }));
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "soopdoop: crew" } });
      expect(received).toEqual([{ hook_event_name: "SessionStart", session_id: "c1", cwd: "/r/vibes", harness: "codex" }]);
    } finally {
      server.stop(true);
    }
    const gone = Bun.spawn(["sh", "-c", guardedHook(process.execPath, "/nonexistent/apps/daemon/src/hook.ts", "codex")("Stop")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    gone.stdin.write('{"session_id":"x"}');
    gone.stdin.end();
    expect(await gone.exited).toBe(0);
    expect(await new Response(gone.stdout).text()).toBe("");
  });
});
