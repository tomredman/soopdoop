import { describe, expect, test } from "bun:test";
import { CLAUDE_EVENTS, guardedHook, parseSettings, prefixedHook, shellQuote, withoutSoopdoopHooks, withSoopdoopHooks } from "./hooks";

const supersetStop = { hooks: [{ type: "command" as const, command: "superset-hooks stop" }] };
const guarded = guardedHook("/Users/me/.bun/bin/bun", "/Users/me/soopdoop/apps/daemon/src/hook.ts");

function commands(settings: ReturnType<typeof withSoopdoopHooks>, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap(function (g) { return g.hooks.map(function (h) { return h.command; }); });
}

describe("claude hooks", function () {
  test("the guarded command runs hook.ts only if it is there, and always exits 0", function () {
    expect(guarded("Stop")).toBe("[ -f '/Users/me/soopdoop/apps/daemon/src/hook.ts' ] && '/Users/me/.bun/bin/bun' '/Users/me/soopdoop/apps/daemon/src/hook.ts' Stop || true");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("the guarded command really is quiet and succeeds when the file is gone", async function () {
    const cmd = guardedHook(process.execPath, "/nonexistent/apps/daemon/src/hook.ts")("Stop");
    const proc = Bun.spawn(["sh", "-c", cmd], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write('{"session_id":"x"}');
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
  });

  test("adds one soopdoop hook per event and keeps Superset's hooks", function () {
    const before = { hooks: { Stop: [supersetStop] }, other: 1 };
    const after = withSoopdoopHooks(before, guarded);
    expect(after.other).toBe(1);
    for (const ev of CLAUDE_EVENTS) {
      expect(commands(after, ev).filter(function (c) { return c === guarded(ev); })).toHaveLength(1);
    }
    expect(after.hooks?.Stop?.[0]?.hooks[0]?.command).toBe("superset-hooks stop");
    // Installing twice does not duplicate.
    expect(JSON.stringify(withSoopdoopHooks(after, guarded))).toBe(JSON.stringify(after));
  });

  test("reinstalling replaces every older soopdoop form", function () {
    const oldBare = withSoopdoopHooks({}, prefixedHook("soopdoop"));
    const oldPath = withSoopdoopHooks(oldBare, prefixedHook("/opt/homebrew/bin/bun /Users/me/soopdoop/apps/daemon/src/cli.ts"));
    expect(commands(oldPath, "Stop")).toEqual(["/opt/homebrew/bin/bun /Users/me/soopdoop/apps/daemon/src/cli.ts hook Stop"]);
    const now = withSoopdoopHooks(oldPath, guarded);
    expect(commands(now, "Stop")).toEqual([guarded("Stop")]);
  });

  test("uninstall removes only ours, in any form", function () {
    const installed = withSoopdoopHooks({ hooks: { Stop: [supersetStop] } }, guarded);
    expect(withoutSoopdoopHooks(installed).hooks).toEqual({ Stop: [supersetStop] });
    const legacy = withSoopdoopHooks({ hooks: { Stop: [supersetStop] } }, prefixedHook("soopdoop"));
    expect(withoutSoopdoopHooks(legacy).hooks).toEqual({ Stop: [supersetStop] });
  });

  test("a project path that merely contains the word soopdoop is not ours", function () {
    const theirs = { hooks: { Stop: [{ hooks: [{ type: "command" as const, command: "/Users/me/projects/soopdoop/scripts/notify.sh Stop" }] }] } };
    expect(withoutSoopdoopHooks(theirs).hooks).toEqual(theirs.hooks);
  });

  test("parseSettings keeps unknown keys and refuses hooks it cannot read exactly", function () {
    const ok = parseSettings({ theme: "dark", hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "x", timeout: 3 }] }] } });
    expect(ok.theme).toBe("dark");
    expect(ok.hooks?.Stop?.[0]?.matcher).toBe("*");
    expect(ok.hooks?.Stop?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(parseSettings({ theme: "dark" }).hooks).toBeUndefined();
    expect(function () { parseSettings({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "hi" }] }] } }); }).toThrow("leaving the file alone");
    expect(function () { parseSettings("nope"); }).toThrow("not a JSON object");
  });
});
