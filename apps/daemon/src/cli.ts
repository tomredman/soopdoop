#!/usr/bin/env bun
// ABOUTME: The soopdoop daemon CLI: pair with the rail, install hooks, serve presence, and the `hook` subcommand harnesses call.
// ABOUTME: `serve` listens on localhost for hook posts, keeps the subset, and reports it to Convex when it changes.
import { hostname, homedir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { installClaudeHooks, uninstallClaudeHooks } from "./hooks";
import { apply, sweep, toReport, type HookEvent, type Subset } from "./state";

const PORT = 47311;
const STALE_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60_000;
const CONFIG = path.join(homedir(), ".soopdoop", "config.json");
// The daemon does not import the backend's generated API; it names the one public mutation it calls.
const reportSubset = makeFunctionReference<"mutation">("subsets:report");

interface Config {
  convexUrl: string;
  token: string;
  privateDirs?: string[];
}

async function readConfig(): Promise<Config> {
  const f = Bun.file(CONFIG);
  if (!(await f.exists())) throw new Error(`Not paired. Run: soopdoop pair <convex-url> <token>`);
  return (await f.json()) as Config;
}

async function pair(convexUrl: string, token: string): Promise<void> {
  await Bun.write(CONFIG, JSON.stringify({ convexUrl, token, privateDirs: [] }, null, 2) + "\n");
  console.log(`Paired. Config at ${CONFIG}. Add folders to privateDirs to keep their agents private.`);
}

// Called by the harness. Reads the JSON payload on stdin and posts it to the daemon. Never fails the harness.
async function hook(event: string): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    const payload = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    await fetch(`http://127.0.0.1:${PORT}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, hook_event_name: event }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // The daemon is not running, or the payload was odd. The harness must never notice.
  }
}

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
        const ev = (await req.json()) as HookEvent;
        if (apply(subset, ev, Date.now(), config.privateDirs ?? [])) dirty = true;
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
  case "install-hooks":
    await installClaudeHooks(rest[0] ?? "soopdoop");
    console.log("Claude Code hooks installed.");
    break;
  case "uninstall-hooks":
    await uninstallClaudeHooks();
    console.log("Claude Code hooks removed.");
    break;
  case "hook":
    await hook(rest[0] ?? "");
    break;
  case "serve":
    await serve();
    break;
  default:
    console.log("soopdoop <pair|install-hooks|uninstall-hooks|serve|hook>");
}
