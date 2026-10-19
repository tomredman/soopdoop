import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings, settingsPath } from "./config";
import {
  allowanceLimit, appendHandoffLog, handoffsCommand, handoffsLogPath, isSettled, parseHandoffLog, readHandoffLog, spentOnHandoffs,
} from "./handoff-log";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-hlog-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

describe("the hand-off log", function () {
  test("keeps who, which agent, when, how, size and cost, one JSON line each, and reads them back", async function () {
    const home = await tempDir();
    const at = Date.parse("2026-10-18T10:00:00.000Z");
    await appendHandoffLog({ at, event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: 412 }, home);
    await appendHandoffLog({ at: at + HOUR, event: "reported", handoffId: "h1", agentId: "s1", by: "agent", usd: 0.42, chars: 80 }, home);
    const text = await readFile(handoffsLogPath(home), "utf8");
    expect(text.split("\n")[0]).toBe('{"at":"2026-10-18T10:00:00.000Z","event":"delivered","handoffId":"h1","fromHandle":"ada","agentId":"s1","harness":"claude-code","channel":"socket","chars":412}');
    const lines = await readHandoffLog(home);
    expect(lines).toEqual([
      { at, event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: 412 },
      { at: at + HOUR, event: "reported", handoffId: "h1", agentId: "s1", by: "agent", usd: 0.42, chars: 80 },
    ]);
    expect(isSettled(lines, "h1")).toBe(true);
    expect(isSettled(lines, "h2")).toBe(false);
  });

  test("skips lines that are not its own", function () {
    expect(parseHandoffLog('nope\n{"at":"x","event":"delivered","handoffId":"h"}\n{"at":"2026-10-18T10:00:00Z","event":"other","handoffId":"h"}\n{"at":"2026-10-18T10:00:00Z","event":"told","handoffId":"h2","usd":-1}\n'))
      .toEqual([{ at: Date.parse("2026-10-18T10:00:00Z"), event: "told", handoffId: "h2" }]);
  });
});

describe("the hand-off allowance", function () {
  test("adds up what hand-offs cost in the last 24 hours", function () {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(spentOnHandoffs([
      { at: now - HOUR, event: "reported", handoffId: "a", usd: 1.5 },
      { at: now - 23 * HOUR, event: "reported", handoffId: "b", usd: 2 },
      { at: now - 25 * HOUR, event: "reported", handoffId: "c", usd: 9 },
      { at: now - HOUR, event: "delivered", handoffId: "d" },
    ], now)).toBe(3.5);
  });

  test("stops a hand-off once the allowance is spent, or when it is $0, and names the allowance", function () {
    expect(allowanceLimit(10, 9.99)).toBeNull();
    expect(allowanceLimit(10, 10)).toBe("This Mac's hand-off allowance ($10.00 a day) is spent: $10.00 in the last 24 hours. Its owner can raise it with: soopdoop handoffs <dollars>.");
    expect(allowanceLimit(0, 0)).toBe("This Mac's hand-off allowance is $0, so its agents run no hand-offs. Its owner can raise it with: soopdoop handoffs <dollars>.");
  });

  test("soopdoop handoffs shows it, and soopdoop handoffs <dollars> sets it and keeps the other settings", async function () {
    const home = await tempDir();
    await writeFile(settingsPath(home), JSON.stringify({ autoUpdate: false, futureKey: 1 }));
    await appendHandoffLog({ at: Date.now() - HOUR, event: "delivered", handoffId: "h1" }, home);
    await appendHandoffLog({ at: Date.now() - HOUR, event: "reported", handoffId: "h1", usd: 1.25 }, home);
    const out: string[] = [];
    await handoffsCommand([], home, function (l) { out.push(l); });
    expect(out).toEqual([
      "Hand-off allowance: $10.00 in any 24 hours for crewmates' hand-offs run by this Mac's agents, at API prices.",
      "Spent in the last 24 hours: $1.25 (1 hand-off run).",
      "Change it with: soopdoop handoffs <dollars a day>",
    ]);
    out.length = 0;
    await handoffsCommand(["4.5"], home, function (l) { out.push(l); });
    expect(out[0]).toBe("Hand-off allowance: $4.50 in any 24 hours for crewmates' hand-offs run by this Mac's agents, at API prices.");
    expect(out).toHaveLength(2);
    const settings = await readSettings(settingsPath(home));
    expect(settings.handoffDailyUsd).toBe(4.5);
    expect(settings.autoUpdate).toBe(false);
    expect(JSON.parse(await readFile(settingsPath(home), "utf8")).futureKey).toBe(1);
    out.length = 0;
    await handoffsCommand(["0"], home, function (l) { out.push(l); });
    expect(out[0]).toBe("Hand-off allowance: $0, so this Mac's agents run no crewmates' hand-offs.");
    expect(handoffsCommand(["-1"], home)).rejects.toThrow("usage: soopdoop handoffs");
    expect(handoffsCommand(["ten"], home)).rejects.toThrow("usage: soopdoop handoffs");
  });
});
