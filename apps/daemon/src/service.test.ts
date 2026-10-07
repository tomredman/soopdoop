import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { infoPlist } from "./app";
import { plist, serviceSpecs } from "./service";

const dirs: string[] = [];
function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("Expected a value");
  return x;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("background services", function () {
  const specs = serviceSpecs("/Users/me/.soopdoop/app", "/Users/me/.bun/bin/bun", "/Users/me/.soopdoop");

  test("runs the rail, the daemon, the app, the watcher and the updater, with an absolute bun", function () {
    expect(specs.map(function (s) { return [s.label, s.program, s.port, s.everySeconds]; })).toEqual([
      ["com.soopdoop.rail", ["/Users/me/.bun/bin/bun", "/Users/me/.soopdoop/app/apps/rail/serve.ts"], 47312, undefined],
      ["com.soopdoop.daemon", ["/Users/me/.bun/bin/bun", "/Users/me/.soopdoop/app/apps/daemon/src/cli.ts", "serve"], 47311, undefined],
      ["com.soopdoop.hud", [path.join(homedir(), "Applications", "soopdoop.app", "Contents", "MacOS", "Soopdoop")], undefined, undefined],
      ["com.soopdoop.watcher", [path.join(homedir(), "Applications", "soopdoop.app", "Contents", "Helpers", "SoopdoopWatcher")], undefined, undefined],
      ["com.soopdoop.updater", ["/Users/me/.bun/bin/bun", "/Users/me/.soopdoop/app/apps/daemon/src/cli.ts", "update", "--auto"], undefined, 21600],
    ]);
    // Setup skips these when the app does not build.
    expect(specs.filter(function (s) { return s.needsApp === true; }).map(function (s) { return s.name; })).toEqual(["hud", "watcher"]);
    for (const s of specs) {
      expect(s.env.PATH?.startsWith("/Users/me/.bun/bin:")).toBe(true);
      expect(s.env.SOOPDOOP_SERVICE).toBe("1");
      expect(s.env.SOOPDOOP_HOME).toBeUndefined();
      expect(s.log.startsWith("/Users/me/.soopdoop/logs/")).toBe(true);
    }
    expect(serviceSpecs("/r", "/b/bun", "/h", "/custom")[0]?.env.SOOPDOOP_HOME).toBe("/custom");
  });

  test("starts at login and restarts when it exits", function () {
    const text = plist(must(specs[0]));
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).toContain("<string>com.soopdoop.rail</string>");
  });

  test("the app starts at login and comes back after a crash, but not after Quit", function () {
    const text = plist(must(specs[2]));
    expect(text).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>");
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("the watcher starts at login and comes back whenever it exits", function () {
    const text = plist(must(specs[3]));
    expect(text).toContain("<string>com.soopdoop.watcher</string>");
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(text).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(text).not.toContain("StartInterval");
    expect(text).toContain("/Users/me/.soopdoop/logs/watcher.log");
  });

  test("the updater runs at login and every 6 hours, and is not kept alive", function () {
    const text = plist(must(specs[4]));
    expect(text).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(text).toContain("<key>StartInterval</key>\n  <integer>21600</integer>");
    expect(text).not.toContain("KeepAlive");
    expect(text).toContain("/Users/me/.soopdoop/logs/update.log");
  });

  test("escapes paths for XML", function () {
    const odd = serviceSpecs("/Users/me/Tom & Jerry's <code>", "/b/bun", "/h");
    const text = plist(must(odd[0]));
    expect(text).toContain("/Users/me/Tom &amp; Jerry's &lt;code&gt;/apps/rail/serve.ts");
    expect(text).not.toContain("Tom & Jerry");
  });

  test.if(process.platform === "darwin")("is a property list macOS accepts", async function () {
    const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-plist-"));
    dirs.push(dir);
    for (const spec of serviceSpecs("/Users/me/Tom & Jerry/app", "/b/bun", "/h")) {
      const file = path.join(dir, `${spec.label}.plist`);
      await Bun.write(file, plist(spec));
      const lint = Bun.spawnSync(["plutil", "-lint", file]);
      expect(lint.exitCode).toBe(0);
    }
    const info = path.join(dir, "Info.plist");
    await Bun.write(info, infoPlist("0.2.0 & <beta>"));
    expect(Bun.spawnSync(["plutil", "-lint", info]).exitCode).toBe(0);
  });

  test("the app has no Dock icon and names its version", function () {
    const text = infoPlist("0.2.0");
    expect(text).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(text).toContain("<key>CFBundleShortVersionString</key>\n  <string>0.2.0</string>");
    expect(text).toContain("<string>com.soopdoop.app</string>");
  });
});
