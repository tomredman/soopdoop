import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, writeConfig } from "@soopdoop/daemon/src/config";
import { localInfo, machineName, pairHere } from "./local";

const ORIGIN = "http://127.0.0.1:47312";
const CONVEX = "https://nautical-dalmatian-541.convex.cloud";
const TOKEN = "sd_" + "0123456789abcdef".repeat(2);

const dirs: string[] = [];
async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-local-"));
  dirs.push(dir);
  return path.join(dir, "home", "config.json");
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function pairRequest(body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/local/pair`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("pairing this machine from the rail", function () {
  test("machine names are short and plain", function () {
    expect(machineName("MBP16.local")).toBe("mbp16");
    expect(machineName("Tom's MacBook Pro")).toBe("tom-s-macbook-pro");
    expect(machineName("...")).toBe("this-machine");
  });

  test("says whether this machine is paired, only to the rail's own page", async function () {
    const file = await tempConfig();
    const ask = new Request(`${ORIGIN}/local`, { headers: { host: "127.0.0.1:47312" } });
    expect(await (await localInfo(ask, ORIGIN, file)).json()).toEqual({ machine: machineName(), paired: false });
    await writeConfig({ convexUrl: CONVEX, token: TOKEN, privateDirs: [] }, file);
    expect(await (await localInfo(ask, ORIGIN, file)).json()).toEqual({ machine: machineName(), paired: true });
    // A DNS name pointed at 127.0.0.1 by another site.
    const rebound = new Request("http://evil.example:47312/local", { headers: { host: "evil.example:47312" } });
    expect((await localInfo(rebound, ORIGIN, file)).status).toBe(403);
  });

  test("writes the daemon's config with this server's Convex URL, readable only by the owner", async function () {
    const file = await tempConfig();
    const res = await pairHere(pairRequest({ token: TOKEN, convexUrl: "https://attacker.example" }), ORIGIN, CONVEX, file);
    expect(res.status).toBe(200);
    expect(await readConfig(file)).toEqual({ convexUrl: CONVEX, token: TOKEN, privateDirs: [] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("refuses other origins and anything that is not a daemon token", async function () {
    const file = await tempConfig();
    expect((await pairHere(pairRequest({ token: TOKEN }, "https://evil.example"), ORIGIN, CONVEX, file)).status).toBe(403);
    expect((await pairHere(pairRequest({ token: TOKEN }, null), ORIGIN, CONVEX, file)).status).toBe(403);
    expect((await pairHere(pairRequest({ token: "sd_short" }), ORIGIN, CONVEX, file)).status).toBe(400);
    expect((await pairHere(pairRequest("not an object"), ORIGIN, CONVEX, file)).status).toBe(400);
    expect(await readConfig(file)).toBeNull();
  });

  test("keeps a working pairing unless asked to replace it, and keeps private folders", async function () {
    const file = await tempConfig();
    await writeConfig({ convexUrl: CONVEX, token: "sd_old", privateDirs: ["/secret"] }, file);
    expect((await pairHere(pairRequest({ token: TOKEN }), ORIGIN, CONVEX, file)).status).toBe(409);
    expect((await readConfig(file))?.token).toBe("sd_old");
    expect((await pairHere(pairRequest({ token: TOKEN, replace: true }), ORIGIN, CONVEX, file)).status).toBe(200);
    expect(await readConfig(file)).toEqual({ convexUrl: CONVEX, token: TOKEN, privateDirs: ["/secret"] });
  });
});
