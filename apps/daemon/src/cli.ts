#!/usr/bin/env bun
// ABOUTME: The soopdoop CLI: one-command setup, the background services, hooks, and the daemon itself (`serve`, `hook`).
// ABOUTME: `serve` listens on localhost for hook posts, keeps the subset, and reports it to Convex once this machine is paired.
import { lstat, readlink, stat, symlink, unlink as removeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { configPath, configStamp, readConfig, soopdoopHome, writeConfig, type Config } from "./config";
import { forwardHook } from "./hook";
import { claudeSettingsPath, guardedHook, installClaudeHooks, prefixedHook, uninstallClaudeHooks } from "./hooks";
import {
  answers, DAEMON_PORT, isLoaded, load, openInBrowser, plistPath, portOwner, RAIL_URL, restart, serviceSpecs, unload, waitFor,
} from "./service";
import { apply, parseHookEvent, sweep, toReport, type Subset } from "./state";

// SOOPDOOP_PORT exists so tests and a second daemon never take the real port.
const PORT = Number(process.env.SOOPDOOP_PORT ?? String(DAEMON_PORT));
const STALE_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60_000;
const MIN_BUN = [1, 3];
// The checkout this file lives in: apps/daemon/src → the repo root.
const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
// The hook file next to this one, run by this bun. Works from any shell and needs nothing on PATH.
const HOOK_FILE = path.join(import.meta.dir, "hook.ts");
// The daemon does not import the backend's generated API; it names the one public mutation it calls.
const reportSubset = makeFunctionReference<"mutation">("subsets:report");

function tilde(p: string): string {
  const home = homedir();
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

async function pair(convexUrl: string, token: string): Promise<void> {
  let privateDirs: string[] = [];
  try {
    privateDirs = (await readConfig())?.privateDirs ?? [];
  } catch {
    // An unreadable old config has nothing worth keeping.
  }
  await writeConfig({ convexUrl, token, privateDirs });
  console.log(`Paired. Config at ${tilde(configPath())}. Add folders to privateDirs there to keep their agents private.`);
}

async function serve(): Promise<void> {
  const subset: Subset = new Map();
  let dirty = true;
  let reporting = false;
  let paired: { config: Config; client: ConvexHttpClient } | null = null;
  let stamp = -1;

  // Picks up a new or changed pairing without a restart: the rail writes the file when it pairs this machine.
  async function loadPairing(): Promise<void> {
    const next = await configStamp();
    if (next === stamp) return;
    stamp = next;
    try {
      const config = await readConfig();
      paired = config === null ? null : { config, client: new ConvexHttpClient(config.convexUrl) };
      if (paired === null) console.log(`Not paired yet. Sign in on the rail (${RAIL_URL}) and it pairs this machine.`);
      else {
        console.log(`Paired. Reporting to ${paired.config.convexUrl}`);
        dirty = true;
      }
    } catch (e) {
      paired = null;
      console.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function report(): Promise<void> {
    if (paired === null || reporting) return;
    reporting = true;
    try {
      await paired.client.mutation(reportSubset, { token: paired.config.token, agents: toReport(subset) });
      dirty = false;
    } catch (e) {
      console.error("report failed:", e instanceof Error ? e.message : e);
    } finally {
      reporting = false;
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
        if (apply(subset, ev, Date.now(), paired?.config.privateDirs ?? [])) dirty = true;
        return new Response("ok");
      }
      if (url.pathname === "/status") {
        return Response.json({ machine: hostname(), paired: paired !== null, agents: toReport(subset) });
      }
      return new Response("soopdoop daemon", { status: 404 });
    },
  });

  setInterval(function () {
    if (sweep(subset, Date.now(), STALE_MS)) dirty = true;
    void report();
  }, HEARTBEAT_MS);
  // Report promptly after a change, coalescing bursts, and notice a new pairing within a second.
  setInterval(function () {
    void loadPairing().then(function () {
      if (dirty) void report();
    });
  }, 1_000);

  await loadPairing();
  await report();
  console.log(`soopdoop daemon on 127.0.0.1:${PORT} · ${hostname()}`);
}

function bunIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_BUN;
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

// Makes `soopdoop` work from any terminal by linking it next to bun, which Bun's installer puts on PATH.
async function linkCommand(): Promise<string | null> {
  const binDir = path.dirname(process.execPath);
  const link = path.join(binDir, "soopdoop");
  const target = path.join(ROOT, "bin", "soopdoop");
  try {
    const st = await lstat(link);
    // Only ever replace our own link, never someone else's file.
    if (!st.isSymbolicLink() || !(await readlink(link)).endsWith(path.join("bin", "soopdoop"))) return null;
    await removeFile(link);
  } catch {
    // Nothing there yet.
  }
  try {
    await symlink(target, link);
    return link;
  } catch {
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function backUpClaudeSettings(): Promise<string | null> {
  const settings = Bun.file(claudeSettingsPath());
  const backup = claudeSettingsPath() + ".before-soopdoop";
  if (!(await settings.exists())) return null;
  if (!(await Bun.file(backup).exists())) await Bun.write(backup, settings);
  return backup;
}

async function setup(args: string[]): Promise<void> {
  const inviteAt = args.indexOf("--invite");
  const invite = inviteAt === -1 ? undefined : args[inviteAt + 1];
  if (inviteAt !== -1 && (invite === undefined || !/^[a-f0-9]{32}$/.test(invite))) {
    throw new Error("--invite needs the code from the invite message, 32 letters and digits.");
  }
  const home = soopdoopHome();
  console.log(`soopdoop setup · ${tilde(ROOT)}\n`);

  if (!bunIsNewEnough(Bun.version)) {
    throw new Error(`soopdoop needs Bun ${MIN_BUN.join(".")} or newer; this is ${Bun.version}. Run \`bun upgrade\`, then this again.`);
  }
  console.log(`· Bun ${Bun.version}`);

  // Hooks: how Claude Code tells the daemon which sessions are running.
  if (await isDirectory(path.dirname(claudeSettingsPath()))) {
    const backup = await backUpClaudeSettings();
    await installClaudeHooks(guardedHook(process.execPath, HOOK_FILE));
    console.log(`· Claude Code hooks added to ${tilde(claudeSettingsPath())}${backup === null ? "" : ` (your old file: ${tilde(backup)})`}`);
  } else {
    console.log("· Claude Code not found (no ~/.claude). Your agents will not show until you install it and run setup again.");
  }

  const link = await linkCommand();
  if (link !== null) console.log(`· \`soopdoop\` command: ${tilde(link)}`);

  if (process.platform !== "darwin") {
    console.log(`\nBackground services are macOS-only for now. Run these two, each in its own terminal:\n` +
      `  bun ${ROOT}/apps/daemon/src/cli.ts serve\n  bun ${ROOT}/apps/rail/serve.ts\nThen open ${RAIL_URL}`);
    return;
  }

  // Background services. Stop ours first, so a port still taken afterwards belongs to something else.
  const specs = serviceSpecs(ROOT, process.execPath, home, process.env.SOOPDOOP_HOME);
  for (const spec of specs) await unload(spec.label);
  for (const spec of specs) {
    const freed = await waitFor(async function () { return (await portOwner(spec.port)) === null; }, 5_000);
    if (!freed) {
      const owner = await portOwner(spec.port);
      throw new Error(`Port ${spec.port} is taken by pid ${owner?.pid ?? "?"} (${owner?.command ?? "unknown"}). ` +
        `If that is an older soopdoop you started by hand, stop it with \`kill ${owner?.pid ?? "<pid>"}\`, then run setup again.`);
    }
  }
  for (const spec of specs) await load(spec);
  const railUp = await waitFor(function () { return answers(`${RAIL_URL}config.json`); }, 30_000);
  const daemonUp = await waitFor(function () { return answers(`http://127.0.0.1:${DAEMON_PORT}/status`); }, 10_000);
  if (!railUp || !daemonUp) {
    throw new Error(`The ${railUp ? "daemon" : "rail"} did not start. Its log: ${tilde(path.join(home, "logs", railUp ? "daemon.log" : "rail.log"))}`);
  }
  console.log("· The rail and the daemon run in the background, and start again when you log in.");

  const url = invite === undefined ? RAIL_URL : `${RAIL_URL}?invite=${invite}`;
  const opened = !args.includes("--no-open");
  if (opened) await openInBrowser(url);
  let paired = false;
  try {
    paired = (await readConfig()) !== null;
  } catch {
    paired = false;
  }
  if (paired && invite === undefined) {
    console.log(`\nDone. This Mac was already paired. The rail: ${url}`);
  } else {
    console.log(`\nNext, ${opened ? "in the browser tab that just opened" : `open ${url}`}:\n` +
      "  1. Sign in with Superset.\n" +
      "  2. Pick a handle. If you use your Superset handle, soopdoop links your Superset profile too.\n" +
      `This Mac pairs itself${invite === undefined ? "." : ", and the invite makes you friends with whoever sent it."}`);
  }
  console.log(`\nLater: \`soopdoop status\`, \`soopdoop logs\`, \`soopdoop update\`, \`soopdoop uninstall\`.`);
}

async function status(): Promise<void> {
  const home = soopdoopHome();
  const git = Bun.spawnSync(["git", "-C", ROOT, "log", "-1", "--format=%h %s"], { stdout: "pipe", stderr: "pipe" });
  console.log(`soopdoop · ${tilde(ROOT)} · ${git.stdout.toString().trim() || "not a git checkout"}`);
  for (const spec of serviceSpecs(ROOT, process.execPath, home)) {
    const loaded = process.platform === "darwin" ? await isLoaded(spec.label) : false;
    const up = await answers(spec.name === "rail" ? `${RAIL_URL}config.json` : `http://127.0.0.1:${spec.port}/status`);
    const where = spec.name === "rail" ? RAIL_URL : `127.0.0.1:${spec.port}`;
    console.log(`${spec.name.padEnd(7)} ${up ? "running" : "not answering"} · ${where} · ${loaded ? "background service" : "no background service"} · log ${tilde(spec.log)}`);
  }
  let config: Config | null = null;
  try {
    config = await readConfig();
  } catch (e) {
    console.log(`paired  config unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`paired  ${config === null ? `no · sign in at ${RAIL_URL}` : `yes · ${config.convexUrl}`}`);
  const settings = Bun.file(claudeSettingsPath());
  const ours = (await settings.exists()) && (await settings.text()).includes(HOOK_FILE);
  console.log(`hooks   ${ours ? "installed" : "not installed for this checkout"} · ${tilde(claudeSettingsPath())}`);
}

async function update(): Promise<void> {
  const pull = Bun.spawnSync(["git", "-C", ROOT, "pull", "--ff-only"], { stdout: "inherit", stderr: "inherit" });
  if (pull.exitCode !== 0) {
    throw new Error(`git pull failed in ${tilde(ROOT)}. If its branch is gone from GitHub, run \`git -C ${tilde(ROOT)} switch main\`, then update again.`);
  }
  const install = Bun.spawnSync([process.execPath, "install"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) throw new Error("bun install failed.");
  if (process.platform === "darwin") {
    for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) {
      if (await isLoaded(spec.label)) await restart(spec.label);
    }
  }
  console.log("Updated and restarted.");
}

async function uninstall(): Promise<void> {
  await uninstallClaudeHooks();
  console.log(`· Removed the soopdoop hooks from ${tilde(claudeSettingsPath())}. Other hooks are untouched.`);
  if (process.platform === "darwin") {
    for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) {
      await unload(spec.label);
      await removeFile(plistPath(spec.label)).catch(function () { /* already gone */ });
    }
    console.log("· Stopped the background rail and daemon.");
  }
  const link = path.join(path.dirname(process.execPath), "soopdoop");
  try {
    if ((await readlink(link)).startsWith(ROOT)) await removeFile(link);
  } catch {
    // No link of ours.
  }
  console.log(`\nLeft in place: your pairing and logs in ${tilde(soopdoopHome())}, and the code in ${tilde(ROOT)}. Delete them by hand if you want them gone.`);
}

async function logs(): Promise<void> {
  const home = soopdoopHome();
  const files = ["rail.log", "daemon.log"].map(function (f) { return path.join(home, "logs", f); });
  await Bun.spawn(["tail", "-n", "40", "-F", ...files], { stdout: "inherit", stderr: "inherit" }).exited;
}

const HELP = `soopdoop setup [--invite <code>] [--no-open]   install, run in the background, open the rail
soopdoop status                                 what is running, paired, hooked
soopdoop open | logs                            open the rail · follow the logs
soopdoop start | stop | restart                 the background rail and daemon
soopdoop update                                 git pull, bun install, restart
soopdoop uninstall                              remove hooks and background services
soopdoop pair <convex-url> <token>              pair by hand (the rail does this for you)
soopdoop install-hooks | uninstall-hooks | serve | hook <event>`;

const [cmd, ...rest] = Bun.argv.slice(2);
try {
  switch (cmd) {
    case "setup":
      await setup(rest);
      break;
    case "status":
      await status();
      break;
    case "open":
      await openInBrowser(RAIL_URL);
      break;
    case "logs":
      await logs();
      break;
    case "start":
      for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome(), process.env.SOOPDOOP_HOME)) await load(spec);
      break;
    case "stop":
      for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) await unload(spec.label);
      break;
    case "restart":
      for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) await restart(spec.label);
      break;
    case "update":
      await update();
      break;
    case "uninstall":
      await uninstall();
      break;
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
      console.log(HELP);
  }
} catch (e) {
  console.error(`soopdoop: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
