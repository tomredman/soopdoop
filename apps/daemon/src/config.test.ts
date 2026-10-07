import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configStamp, parseConfig, readConfig, readSettings, writeConfig, writeSettings } from "./config";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-config-"));
  dirs.push(dir);
  return path.join(dir, "home");
}

afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("the pairing file", function () {
  test("missing means not paired", async function () {
    const file = path.join(await tempHome(), "config.json");
    expect(await readConfig(file)).toBeNull();
    expect(await configStamp(file)).toBe(0);
  });

  test("is written for its owner only, in one step, and read back", async function () {
    const home = await tempHome();
    const file = path.join(home, "config.json");
    await writeConfig({ convexUrl: "https://x.convex.cloud", token: "sd_1", privateDirs: ["/secret"] }, file);
    expect(await readConfig(file)).toEqual({ convexUrl: "https://x.convex.cloud", token: "sd_1", privateDirs: ["/secret"] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    // No temporary file left behind.
    expect(await readdir(home)).toEqual(["config.json"]);
  });

  test("its stamp changes when it is written again", async function () {
    const file = path.join(await tempHome(), "config.json");
    await writeConfig({ convexUrl: "https://x.convex.cloud", token: "sd_1", privateDirs: [] }, file);
    const first = await configStamp(file);
    await Bun.sleep(20);
    await writeConfig({ convexUrl: "https://x.convex.cloud", token: "sd_2", privateDirs: [] }, file);
    expect(await configStamp(file)).not.toBe(first);
  });

  test("an unreadable file is an error, not a silent unpaired machine", async function () {
    const file = path.join(await tempHome(), "config.json");
    await Bun.write(file, JSON.stringify({ token: 1 }));
    await expect(readConfig(file)).rejects.toThrow("Bad config");
    expect(parseConfig({ convexUrl: "u", token: "t", privateDirs: ["/a", 2] })).toEqual({ convexUrl: "u", token: "t", privateDirs: ["/a"] });
  });
});

describe("the settings file", function () {
  test("everything is on until it is turned off", async function () {
    const file = path.join(await tempHome(), "settings.json");
    expect(await readSettings(file)).toEqual({ autoUpdate: true, autoOpen: true });
    await Bun.write(file, "not json");
    expect(await readSettings(file)).toEqual({ autoUpdate: true, autoOpen: true });
    await Bun.write(file, JSON.stringify({ autoOpen: "no" }));
    expect(await readSettings(file)).toEqual({ autoUpdate: true, autoOpen: true });
  });

  test("changing one setting keeps the others, also ones a newer version wrote", async function () {
    const file = path.join(await tempHome(), "settings.json");
    await Bun.write(file, JSON.stringify({ autoUpdate: false, later: 1 }));
    await writeSettings({ autoOpen: false }, file);
    expect(await readSettings(file)).toEqual({ autoUpdate: false, autoOpen: false });
    await writeSettings({ autoUpdate: true }, file);
    // The watcher (Swift) reads this file itself, by these key names.
    expect(await Bun.file(file).json()).toEqual({ autoUpdate: true, later: 1, autoOpen: false });
  });
});
