import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, readSettings, writeConfig, writeSettings } from "@soopdoop/daemon/src/config";
import { takeUpdateRequest, writeUpdateState } from "@soopdoop/daemon/src/update";
import { localInfo, machineName, pairHere, settingsHere, updateHere, type LocalServer } from "./local";

const ORIGIN = "http://127.0.0.1:47312";
const PROD = "https://fleet-skunk-723.convex.cloud";
const DEV = "https://nautical-dalmatian-541.convex.cloud";
const TOKEN = "sd_" + "0123456789abcdef".repeat(2);

let home = "";
const savedHome = process.env.SOOPDOOP_HOME;
beforeAll(async function () {
  // Update state and requests live in SOOPDOOP_HOME; keep them out of the real ~/.soopdoop.
  home = await mkdtemp(path.join(tmpdir(), "soopdoop-local-"));
  process.env.SOOPDOOP_HOME = home;
});
afterAll(async function () {
  if (savedHome === undefined) delete process.env.SOOPDOOP_HOME;
  else process.env.SOOPDOOP_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

let n = 0;
function server(over: Partial<LocalServer> = {}): LocalServer {
  n += 1;
  return {
    railOrigin: ORIGIN,
    convexUrl: PROD,
    version: "0.1.0",
    canUpdate: true,
    configFile: path.join(home, `config-${n}.json`),
    settingsFile: path.join(home, `settings-${n}.json`),
    ...over,
  };
}

function post(route: string, body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const ask = new Request(`${ORIGIN}/local`, { headers: { host: "127.0.0.1:47312" } });

describe("the rail's local server", function () {
  test("machine names are short and plain", function () {
    expect(machineName("MBP16.local")).toBe("mbp16");
    expect(machineName("Tom's MacBook Pro")).toBe("tom-s-macbook-pro");
    expect(machineName("...")).toBe("this-machine");
  });

  test("says whether this machine is paired with this deployment, only to the rail's own page", async function () {
    const s = server();
    const configFile = s.configFile ?? "";
    expect((await (await localInfo(ask, s)).json()).paired).toBe(false);
    await writeConfig({ convexUrl: PROD, token: TOKEN, privateDirs: [] }, configFile);
    expect((await (await localInfo(ask, s)).json()).paired).toBe(true);
    // Paired with the dev deployment while this rail uses production: not paired here.
    await writeConfig({ convexUrl: DEV, token: TOKEN, privateDirs: [] }, configFile);
    expect((await (await localInfo(ask, s)).json()).paired).toBe(false);
    const rebound = new Request("http://evil.example:47312/local", { headers: { host: "evil.example:47312" } });
    expect((await localInfo(rebound, s)).status).toBe(403);
  });

  test("reports the version, a newer release, and the auto-update and auto-open settings", async function () {
    const s = server();
    await writeUpdateState({ latest: "v0.2.0", error: undefined });
    expect(await (await localInfo(ask, s)).json()).toMatchObject({
      version: "0.1.0",
      latest: "v0.2.0",
      newer: true,
      releaseUrl: "https://github.com/tomredman/soopdoop/releases/tag/v0.2.0",
      autoUpdate: true,
      canUpdate: true,
      updating: false,
      updateError: null,
      autoOpen: true,
    });
    await writeUpdateState({ latest: "v0.1.0" });
    expect((await (await localInfo(ask, s)).json()).newer).toBe(false);
    await writeSettings({ autoOpen: false }, s.settingsFile ?? "");
    expect((await (await localInfo(ask, s)).json()).autoOpen).toBe(false);
  });

  test("pairing writes this server's Convex URL, owner-only, and keeps private folders", async function () {
    const s = server();
    const file = s.configFile ?? "";
    expect((await pairHere(post("/local/pair", { token: TOKEN, convexUrl: "https://attacker.example" }), s)).status).toBe(200);
    expect(await readConfig(file)).toEqual({ convexUrl: PROD, token: TOKEN, privateDirs: [] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("pairing refuses other origins and anything that is not a daemon token", async function () {
    const s = server();
    expect((await pairHere(post("/local/pair", { token: TOKEN }, "https://evil.example"), s)).status).toBe(403);
    expect((await pairHere(post("/local/pair", { token: TOKEN }, null), s)).status).toBe(403);
    expect((await pairHere(post("/local/pair", { token: "sd_short" }), s)).status).toBe(400);
    expect((await pairHere(post("/local/pair", "not an object"), s)).status).toBe(400);
    expect(await readConfig(s.configFile ?? "")).toBeNull();
  });

  test("keeps a pairing with this deployment unless asked, but replaces one with another deployment", async function () {
    const s = server();
    const file = s.configFile ?? "";
    await writeConfig({ convexUrl: PROD, token: "sd_old", privateDirs: ["/secret"] }, file);
    expect((await pairHere(post("/local/pair", { token: TOKEN }), s)).status).toBe(409);
    expect((await pairHere(post("/local/pair", { token: TOKEN, replace: true }), s)).status).toBe(200);
    expect(await readConfig(file)).toEqual({ convexUrl: PROD, token: TOKEN, privateDirs: ["/secret"] });
    await writeConfig({ convexUrl: DEV, token: "sd_dev", privateDirs: ["/secret"] }, file);
    expect((await pairHere(post("/local/pair", { token: TOKEN }), s)).status).toBe(200);
    expect(await readConfig(file)).toEqual({ convexUrl: PROD, token: TOKEN, privateDirs: ["/secret"] });
  });

  test("Update now asks the updater job, only from the rail's own page, only when the job exists", async function () {
    const started: string[] = [];
    async function start(label: string): Promise<void> { started.push(label); }
    expect((await updateHere(post("/local/update", {}, "https://evil.example"), server(), start)).status).toBe(403);
    expect((await updateHere(post("/local/update", {}), server({ canUpdate: false }), start)).status).toBe(409);
    expect(started).toEqual([]);
    expect((await updateHere(post("/local/update", {}), server(), start)).status).toBe(202);
    expect(started).toEqual(["com.soopdoop.updater"]);
    expect(await takeUpdateRequest()).toBe(true);
  });

  test("the auto-update switch takes only a true or false, only from the rail's own page", async function () {
    const s = server();
    const file = s.settingsFile ?? "";
    expect((await settingsHere(post("/local/settings", { autoUpdate: false }, "https://evil.example"), s)).status).toBe(403);
    expect((await settingsHere(post("/local/settings", { autoUpdate: "no" }), s)).status).toBe(400);
    expect((await readSettings(file)).autoUpdate).toBe(true);
    await writeSettings({ autoOpen: false }, file);
    expect((await settingsHere(post("/local/settings", { autoUpdate: false }), s)).status).toBe(200);
    expect((await readSettings(file)).autoUpdate).toBe(false);
    expect((await (await localInfo(ask, s)).json()).autoUpdate).toBe(false);
    // The rail's switch leaves auto-open as it was.
    expect((await readSettings(file)).autoOpen).toBe(false);
  });
});
