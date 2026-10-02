#!/usr/bin/env bun
// ABOUTME: The soopdoop daemon CLI: pair with the rail, install hooks, serve presence, and the `hook` subcommand harnesses call.
// ABOUTME: `serve` listens on localhost for hook posts, keeps the subset, and reports it to Convex when it changes.
import { chmod } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { forwardHook } from "./hook";
import { guardedHook, installClaudeHooks, prefixedHook, uninstallClaudeHooks } from "./hooks";
import { apply, isRecord, parseHookEvent, sweep, toReport, type Subset } from "./state";

// SOOPDOOP_HOME and SOOPDOOP_PORT exist so tests and a second daemon never touch the real config or port.
const HOME = process.env.SOOPDOOP_HOME ?? path.join(homedir(), ".soopdoop");
const PORT = Number(process.env.SOOPDOOP_PORT ?? "47311");
const CONFIG = path.join(HOME, "config.json");
const STALE_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60_000;
// The daemon does not import the backend's generated API; it names the one public mutation it calls.
const reportSubset = makeFunctionReference<"mutation">("subsets:report");

interface Config {
  convexUrl: string;
  token: string;
  privateDirs: string[];
}

function parseConfig(raw: unknown): Config {
  if (!isRecord(raw) || typeof raw.convexUrl !== "string" || typeof raw.token !== "string") {
    throw new Error(`Bad config at ${CONFIG}. Run: soopdoop pair <convex-url> <token>`);
  }
  const privateDirs = Array.isArray(raw.privateDirs)
    ? raw.privateDirs.filter(function (d): d is string { return typeof d === "string"; })
    : [];
  return { convexUrl: raw.convexUrl, token: raw.token, privateDirs };
}

async function readConfig(): Promise<Config> {
  const f = Bun.file(CONFIG);
  if (!(await f.exists())) throw new Error(`Not paired. Run: soopdoop pair <convex-url> <token>`);
  const raw: unknown = await f.json();
  return parseConfig(raw);
}

async function pair(convexUrl: string, token: string): Promise<void> {
  await Bun.write(CONFIG, JSON.stringify({ convexUrl, token, privateDirs: [] }, null, 2) + "\n");
  // The token lets anyone report presence as this hacker, so only the owner may read it.
  await chmod(CONFIG, 0o600);
  console.log(`Paired. Config at ${CONFIG}. Add folders to privateDirs to keep their agents private.`);
}

// The hook file next to this one, run by this bun. Works from any shell and needs nothing on PATH.
const HOOK_FILE = path.join(import.meta.dir, "hook.ts");

async function serve(): Promise<void> {
  const config = await readConfig();
  const client = new ConvexHttpClient(config.convexUrl);
  const subset: Subset = new Map();
  let dirty = true;

  async function report(): Promise<void> {
    try {
      await client.mutation(reportSubset, { token: config.token, agents: toReport(subset) });
      dirty = false;
    } catch (e) {
      console.error("report failed:", e instanceof Error ? e.message : e);
    }
  }

  Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/hook") {
        const raw: unknown = await req.json().catch(function () { return null; });
        const ev = parseHookEvent(raw);
        if (ev === null) return new Response("bad hook payload", { status: 400 });
        if (apply(subset, ev, Date.now(), config.privateDirs)) dirty = true;
        return new Response("ok");
      }
      if (url.pathname === "/status") {
        return Response.json({ machine: hostname(), agents: toReport(subset) });
      }
      return new Response("soopdoop daemon", { status: 404 });
    },
  });

  setInterval(function () {
    if (sweep(subset, Date.now(), STALE_MS)) dirty = true;
    void report();
  }, HEARTBEAT_MS);
  // Report promptly after a change, coalescing bursts.
  setInterval(function () {
    if (dirty) void report();
  }, 1_000);

  await report();
  console.log(`soopdoop daemon on 127.0.0.1:${PORT} · ${hostname()} · reporting to ${config.convexUrl}`);
}

const [cmd, ...rest] = Bun.argv.slice(2);
switch (cmd) {
  case "pair": {
    const [url, token] = rest;
    if (url === undefined || token === undefined) throw new Error("usage: soopdoop pair <convex-url> <token>");
    await pair(url, token);
    break;
  }
  case "install-hooks": {
    // An argument installs the older `<prefix> hook <event>` form, e.g. `soopdoop` once that is on PATH.
    const commandFor = rest[0] === undefined ? guardedHook(process.execPath, HOOK_FILE) : prefixedHook(rest[0]);
    await installClaudeHooks(commandFor);
    console.log(`Claude Code hooks installed. Stop runs: ${commandFor("Stop")}`);
    break;
  }
  case "uninstall-hooks":
    await uninstallClaudeHooks();
    console.log("Claude Code hooks removed.");
    break;
  case "hook":
    await forwardHook(rest[0] ?? "", await Bun.stdin.text(), PORT);
    break;
  case "serve":
    await serve();
    break;
  default:
    console.log("soopdoop <pair|install-hooks|uninstall-hooks|serve|hook>");
}
