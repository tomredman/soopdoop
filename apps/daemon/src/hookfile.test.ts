// ABOUTME: Tests editing a harness's hooks file: our entries go in beside everyone else's, every other key and entry stays exactly
// ABOUTME: as it was (whatever its type), a file we cannot read is left alone, and uninstalling removes only ours.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasOurHooks, installHookFile, isOurEntry, uninstallHookFile, withOurHooks, withoutOurHooks, type OurHook } from "./hookfile";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-hookfile-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// Superset's hooks, in the shape it writes them (a command per event, some with a matcher), plus hook types we do not use.
const THEIRS = {
  description: "kept as it is",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "[ -n \"$SUPERSET_HOME_DIR\" ] && SUPERSET_HOOK_HARNESS=codex \"$SUPERSET_HOME_DIR/hooks/notify.sh\" || true" }] }],
    PreToolUse: [{ matcher: "^request_user_input$", hooks: [{ type: "command", command: "notify.sh" }] }],
    PostToolUse: [{ hooks: [{ type: "http", url: "http://localhost:9000/hook", timeout: 3 }, { type: "mcp_tool", server: "audit", tool: "log" }] }],
    Empty: [],
  },
};

const OURS: OurHook[] = [
  { event: "Stop", command: "[ -f '/a/apps/daemon/src/hook.ts' ] && SOOPDOOP_HARNESS=codex '/b/bun' '/a/apps/daemon/src/hook.ts' Stop || true", timeout: 5 },
  { event: "Notification", command: "[ -f '/a/apps/daemon/src/hook.ts' ] && SOOPDOOP_HARNESS=grok '/b/bun' '/a/apps/daemon/src/hook.ts' Notification || true", timeout: 5, matcher: "^(permission_prompt)$" },
];

describe("hooks files", function () {
  test("adds one group per hook of ours and keeps everyone else's exactly; twice changes nothing", function () {
    const after = withOurHooks(THEIRS, OURS);
    expect(after.description).toBe("kept as it is");
    expect(after.hooks).toEqual({
      Stop: [THEIRS.hooks.Stop[0], { hooks: [{ type: "command", command: OURS[0]?.command, timeout: 5 }] }],
      PreToolUse: THEIRS.hooks.PreToolUse,
      PostToolUse: THEIRS.hooks.PostToolUse,
      Empty: [],
      Notification: [{ matcher: "^(permission_prompt)$", hooks: [{ type: "command", command: OURS[1]?.command, timeout: 5 }] }],
    });
    expect(JSON.stringify(withOurHooks(after, OURS))).toBe(JSON.stringify(after));
    expect(hasOurHooks(after, OURS)).toBe(true);
    expect(hasOurHooks(THEIRS, OURS)).toBe(false);
  });

  test("uninstalling removes only ours, in any group", function () {
    const shared = { hooks: { Stop: [{ hooks: [{ type: "command", command: "theirs" }, { type: "command", command: "bun /x/apps/daemon/src/hook.ts Stop" }] }] } };
    expect(withoutOurHooks(shared).hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "theirs" }] }] });
    expect(withoutOurHooks(withOurHooks(THEIRS, OURS))).toEqual(THEIRS);
    expect(isOurEntry({ type: "command", command: "/Users/ada/projects/soopdoop/scripts/notify.sh" })).toBe(false);
  });

  test("refuses a file it cannot read exactly, and leaves it alone", async function () {
    expect(function () { withOurHooks({ hooks: "nope" }, OURS); }).toThrow("leaving the file alone");
    expect(function () { withOurHooks({ hooks: { Stop: {} } }, OURS); }).toThrow("leaving the file alone");
    const dir = await tempDir();
    const file = path.join(dir, "hooks.json");
    await writeFile(file, "{ not json");
    await expect(installHookFile(file, OURS)).rejects.toThrow("not JSON");
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  test("saves the file as it was before the first install, once, and never a file that was only ours", async function () {
    const dir = await tempDir();
    const file = path.join(dir, "hooks.json");
    await writeFile(file, JSON.stringify(THEIRS));
    const backup = await installHookFile(file, OURS);
    expect(backup).toBe(`${file}.before-soopdoop`);
    expect(JSON.parse(await readFile(`${file}.before-soopdoop`, "utf8"))).toEqual(THEIRS);
    await installHookFile(file, OURS);
    expect(JSON.parse(await readFile(`${file}.before-soopdoop`, "utf8"))).toEqual(THEIRS);
    expect(await uninstallHookFile(file)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(THEIRS);

    // Our own file: no backup of it, and uninstalling deletes it.
    const own = path.join(dir, "hooks", "soopdoop.json");
    expect(await installHookFile(own, OURS)).toBeNull();
    expect(await installHookFile(own, OURS)).toBeNull();
    expect(await Bun.file(`${own}.before-soopdoop`).exists()).toBe(false);
    expect(await uninstallHookFile(own, true)).toBe(true);
    expect(await Bun.file(own).exists()).toBe(false);
    expect(await uninstallHookFile(own, true)).toBe(false);
  });
});
