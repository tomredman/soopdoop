#!/usr/bin/env bun
// ABOUTME: The soopdoop CLI: one-command setup, updates, the background services, hooks, and the daemon itself (`serve`, `hook`).
// ABOUTME: `serve` listens on localhost for hook posts, keeps the subset, and reports it to Convex once this machine is paired.
import { lstat, readlink, stat, symlink, unlink as removeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { appBinaryPath, appBundlePath, buildApp, removeApp } from "./app";
import { configPath, configStamp, invitePath, readConfig, readSettings, soopdoopHome, writeConfig, writeSettings, type Config } from "./config";
import { forwardHook } from "./hook";
import { claudeSettingsPath, guardedHook, installClaudeHooks, prefixedHook, uninstallClaudeHooks } from "./hooks";
import { answerReads, summaryFor, updateRouting } from "./operator";
import {
  answers, DAEMON_PORT, isLoaded, load, openInBrowser, plistPath, portOwner, RAIL_URL, restart, serviceSpecs, unload, waitFor, writePlist,
} from "./service";
import { apply, parseHookEvent, sweep, toReport, type Subset } from "./state";
import {
  applyUpdate, checkForUpdate, currentVersion, defaultSteps, installDir, isInstall, isNewer, parseVersion, readUpdateState,
  releasePage, tagFor, takeUpdateRequest,
} from "./update";

// SOOPDOOP_PORT exists so tests and a second daemon never take the real port.
const PORT = Number(process.env.SOOPDOOP_PORT ?? String(DAEMON_PORT));
const STALE_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 60_000;
const MIN_BUN = [1, 3];
// The checkout this file lives in: apps/daemon/src → the repo root.
const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
// The hook file next to this one, run by this bun. Works from any shell and needs nothing on PATH.
const HOOK_FILE = path.join(import.meta.dir, "hook.ts");
// The MCP server Claude Code starts for the ask_operator tool.
const MCP_FILE = path.join(import.meta.dir, "mcp.ts");
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
  // http reports presence; live follows the Operator's read requests over a WebSocket.
  let paired: { config: Config; client: ConvexHttpClient; live: ConvexClient; stopReads: () => void } | null = null;
  let stamp = -1;
  // Open agents that finished a turn since the last report: their routing summaries go out after it.
  const summariesDue = new Set<string>();

  function unpair(): void {
    if (paired === null) return;
    paired.stopReads();
    void paired.live.close();
    paired = null;
  }

  // Picks up a new or changed pairing without a restart: the rail writes the file when it pairs this machine.
  async function loadPairing(): Promise<void> {
    const next = await configStamp();
    if (next === stamp) return;
    stamp = next;
    try {
      const config = await readConfig();
      unpair();
      if (config !== null) {
        const live = new ConvexClient(config.convexUrl);
        paired = { config, client: new ConvexHttpClient(config.convexUrl), live, stopReads: answerReads(live, config.token, config.convexUrl, subset) };
      }
      if (paired === null) console.log(`Not paired yet. Sign in on the rail (${RAIL_URL}) and it pairs this machine.`);
      else {
        console.log(`Paired. Reporting to ${paired.config.convexUrl}`);
        dirty = true;
      }
    } catch (e) {
      unpair();
      console.error(e instanceof Error ? e.message : String(e));
    }
  }

  // After a report, so the server knows the agent before its summary arrives.
  async function sendSummaries(now: NonNullable<typeof paired>): Promise<void> {
    for (const agentId of [...summariesDue]) {
      summariesDue.delete(agentId);
      const summary = await summaryFor(subset, agentId);
      if (summary === null) continue;
      try {
        await now.client.mutation(updateRouting, { token: now.config.token, agentId, summary });
      } catch (e) {
        console.error("routing summary failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  async function report(): Promise<void> {
    const now = paired;
    if (now === null || reporting) return;
    reporting = true;
    try {
      await now.client.mutation(reportSubset, { token: now.config.token, agents: toReport(subset) });
      dirty = false;
      await sendSummaries(now);
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
        // Hooks come from hook.ts, never from a web page. Browsers always send Origin on a POST, so refusing those
        // keeps any site from adding made-up sessions to this hacker's presence.
        if (req.headers.get("origin") !== null) return new Response("forbidden", { status: 403 });
        const raw: unknown = await req.json().catch(function () { return null; });
        const ev = parseHookEvent(raw);
        if (ev === null) return new Response("bad hook payload", { status: 400 });
        if (apply(subset, ev, Date.now(), paired?.config.privateDirs ?? [])) dirty = true;
        if (ev.hook_event_name === "Stop" && subset.get(ev.session_id)?.open === true) summariesDue.add(ev.session_id);
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

// The rail knows which deployment it uses; ask it whether this machine is paired with that one. Null when it is not up.
async function railSaysPaired(): Promise<boolean | null> {
  try {
    const res = await fetch(`${RAIL_URL}local`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    return typeof raw === "object" && raw !== null && "paired" in raw && typeof raw.paired === "boolean" ? raw.paired : null;
  } catch {
    return null;
  }
}

// Gives every Claude Code session the ask_operator tool, at user scope. Needs the claude command: a setup run from a
// terminal does it; the updater has no PATH to claude and skips it, which is fine because the registered path never moves.
function registerMcp(): "added" | "no-claude" | string {
  const claude = Bun.which("claude");
  if (claude === null) return "no-claude";
  Bun.spawnSync([claude, "mcp", "remove", "--scope", "user", "soopdoop"], { stdout: "pipe", stderr: "pipe" });
  const add = Bun.spawnSync([claude, "mcp", "add", "--scope", "user", "soopdoop", "--", process.execPath, MCP_FILE], { stdout: "pipe", stderr: "pipe" });
  return add.exitCode === 0 ? "added" : add.stderr.toString().trim() || `claude mcp add failed (${add.exitCode})`;
}

async function mcpRegistered(): Promise<boolean> {
  try {
    const raw: unknown = await Bun.file(path.join(homedir(), ".claude.json")).json();
    return typeof raw === "object" && raw !== null && "mcpServers" in raw && typeof raw.mcpServers === "object" &&
      raw.mcpServers !== null && "soopdoop" in raw.mcpServers;
  } catch {
    return false;
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
  // For updates, which run the new version's setup: --quiet prints nothing, and --keep-updater leaves the updater job
  // loaded because it is the process doing the update. Every version's setup must keep accepting these flags.
  const quiet = args.includes("--quiet");
  const keepUpdater = args.includes("--keep-updater");
  function say(line: string): void {
    if (!quiet) console.log(line);
  }
  const home = soopdoopHome();
  say(`soopdoop setup · v${await currentVersion(ROOT)} · ${tilde(ROOT)}\n`);

  if (!bunIsNewEnough(Bun.version)) {
    throw new Error(`soopdoop needs Bun ${MIN_BUN.join(".")} or newer; this is ${Bun.version}. Run \`bun upgrade\`, then this again.`);
  }
  say(`· Bun ${Bun.version}`);

  // Hooks: how Claude Code tells the daemon which sessions are running.
  if (await isDirectory(path.dirname(claudeSettingsPath()))) {
    const backup = await backUpClaudeSettings();
    await installClaudeHooks(guardedHook(process.execPath, HOOK_FILE));
    say(`· Claude Code hooks added to ${tilde(claudeSettingsPath())}${backup === null ? "" : ` (your old file: ${tilde(backup)})`}`);
  } else {
    say("· Claude Code not found (no ~/.claude). Your agents will not show until you install it and run setup again.");
  }

  const link = await linkCommand();
  if (link !== null) say(`· \`soopdoop\` command: ${tilde(link)}`);

  if (!keepUpdater) {
    const mcp = registerMcp();
    if (mcp === "added") say("· Claude Code sessions get the ask_operator tool (MCP server \"soopdoop\", user scope).");
    else if (mcp === "no-claude") say("· The claude command is not on PATH, so the ask_operator tool was not added. Run setup again from a terminal where `claude` works.");
    else say(`· Could not add the ask_operator tool: ${mcp}`);
  }

  if (process.platform !== "darwin") {
    say(`\nBackground services are macOS-only for now. Run these two, each in its own terminal:\n` +
      `  bun ${ROOT}/apps/daemon/src/cli.ts serve\n  bun ${ROOT}/apps/rail/serve.ts\n` +
      `Then open ${invite === undefined ? RAIL_URL : `${RAIL_URL}?invite=${invite}`}. Update with \`soopdoop update\`.`);
    return;
  }

  say("· Building the soopdoop app (the first time takes a minute)…");
  const app = await buildApp(ROOT, await currentVersion(ROOT));
  say(app.ok ? `· The app: ${tilde(app.path)}` : `· No app this time: ${app.why}`);
  // The app's agent redeems the invite after its sign-in. Without the app, the web rail gets it in its URL instead.
  if (invite !== undefined && app.ok) await Bun.write(invitePath(), invite + "\n");

  // Background services. Stop ours first, so a port still taken afterwards belongs to something else.
  const all = serviceSpecs(ROOT, process.execPath, home, process.env.SOOPDOOP_HOME);
  const specs = all.filter(function (s) {
    return !(keepUpdater && s.name === "updater") && (s.name !== "hud" || app.ok);
  });
  for (const spec of specs) await unload(spec.label);
  for (const spec of specs) {
    const port = spec.port;
    if (port === undefined) continue;
    const freed = await waitFor(async function () { return (await portOwner(port)) === null; }, 5_000);
    if (!freed) {
      const owner = await portOwner(port);
      throw new Error(`Port ${port} is taken by pid ${owner?.pid ?? "?"} (${owner?.command ?? "unknown"}). ` +
        `If that is an older soopdoop you started by hand, stop it with \`kill ${owner?.pid ?? "<pid>"}\`, then run setup again.`);
    }
  }
  for (const spec of specs) await load(spec);
  // The updater is the one running this: write its plist now, it is read on the next load.
  for (const spec of all) if (keepUpdater && spec.name === "updater") await writePlist(spec);
  const railUp = await waitFor(function () { return answers(`${RAIL_URL}config.json`); }, 30_000);
  const daemonUp = await waitFor(function () { return answers(`http://127.0.0.1:${DAEMON_PORT}/status`); }, 10_000);
  if (!railUp || !daemonUp) {
    throw new Error(`The ${railUp ? "daemon" : "rail"} did not start. Its log: ${tilde(path.join(home, "logs", railUp ? "daemon.log" : "rail.log"))}`);
  }
  say("· The rail and the daemon run in the background and start again when you log in.");
  say(`· New releases install themselves within 6 hours${(await readSettings()).autoUpdate ? "" : " (auto-update is off here)"}. \`soopdoop auto-update off\` stops that.`);
  if (quiet) return;

  if (app.ok) {
    console.log(`\nNext: look for the soopdoop HUD on your screen and the icon in your menu bar.\n` +
      "  1. Sign in with Superset there (your browser opens Superset's page once).\n" +
      "  2. Pick a handle. If you use your Superset handle, soopdoop links your Superset profile too.\n" +
      `This Mac pairs itself${invite === undefined ? "." : ", and the invite makes you friends with whoever sent it."}\n` +
      "The HUD shows while Superset is in front; the menu bar icon shows it any time.");
    console.log(`\nLater: \`soopdoop status\`, \`soopdoop logs\`, \`soopdoop update\`, \`soopdoop uninstall\`.`);
    return;
  }
  const url = invite === undefined ? RAIL_URL : `${RAIL_URL}?invite=${invite}`;
  const opened = !args.includes("--no-open");
  if (opened) await openInBrowser(url);
  // The pairing must be with the deployment the rail uses; one with another deployment is replaced at sign-in.
  const paired = (await railSaysPaired()) === true;
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

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function status(): Promise<void> {
  const home = soopdoopHome();
  const version = await currentVersion(ROOT);
  const settings = await readSettings();
  const state = await readUpdateState();
  console.log(`soopdoop v${version} · ${tilde(ROOT)} · ${(await isInstall(ROOT)) ? "install" : "development checkout"}`);
  const latest = state.latest === undefined ? "not checked yet" : isNewer(state.latest, version) ? `${state.latest} is out` : "up to date";
  const checked = state.checkedAt === undefined ? "" : ` (checked ${ago(state.checkedAt)})`;
  console.log(`updates ${settings.autoUpdate ? "install themselves" : "auto-update off"} · ${latest}${checked}${state.error === undefined ? "" : ` · last problem: ${state.error}`}`);
  for (const spec of serviceSpecs(ROOT, process.execPath, home)) {
    const loaded = process.platform === "darwin" ? await isLoaded(spec.label) : false;
    if (spec.name === "hud") {
      const built = await Bun.file(appBinaryPath()).exists();
      console.log(`hud     ${built ? (loaded ? "running" : "built, not running") : "not built (needs Xcode's command line tools)"} · ${tilde(appBundlePath())}`);
      continue;
    }
    if (spec.port === undefined) {
      console.log(`${spec.name.padEnd(7)} ${loaded ? "every 6 hours, and at login" : "not scheduled"} · log ${tilde(spec.log)}`);
      continue;
    }
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
  const railPaired = await railSaysPaired();
  console.log(`paired  ${config === null
    ? `no · sign in at ${RAIL_URL}`
    : railPaired === false
      ? `with ${config.convexUrl}, not the deployment the rail uses · sign in at ${RAIL_URL} and it pairs again`
      : `yes · ${config.convexUrl}`}`);
  const claude = Bun.file(claudeSettingsPath());
  const ours = (await claude.exists()) && (await claude.text()).includes(HOOK_FILE);
  console.log(`hooks   ${ours ? "installed" : "not installed for this checkout"} · ${tilde(claudeSettingsPath())}`);
  console.log(`operator ${(await mcpRegistered()) ? "ask_operator tool registered in Claude Code" : "ask_operator tool not registered (run soopdoop setup from a terminal)"}`);
}

// `soopdoop update` installs the newest release; `--to vX.Y.Z` moves to that release (also back);
// `--auto` is the updater job: it installs only when auto-update is on or the rail asked.
async function update(args: string[]): Promise<void> {
  const auto = args.includes("--auto");
  const toAt = args.indexOf("--to");
  const to = toAt === -1 ? undefined : args[toAt + 1];
  function log(line: string): void {
    console.log(auto ? `${new Date().toISOString()} ${line}` : line);
  }
  if (!(await isInstall(ROOT))) {
    throw new Error(`${tilde(ROOT)} is a development checkout on a branch; update it with git. ` +
      `\`soopdoop update\` is for installs (${tilde(installDir())}).`);
  }
  let target: string;
  if (to !== undefined) {
    const v = parseVersion(to);
    if (v === null) throw new Error(`--to needs a release like v0.1.0, not ${to}.`);
    target = tagFor(v);
  } else {
    const check = await checkForUpdate(ROOT);
    const requested = auto ? await takeUpdateRequest() : false;
    if (check.latest === null) {
      log("No releases yet.");
      return;
    }
    if (!check.newer) {
      log(`Up to date: v${check.current}.`);
      return;
    }
    if (auto && !requested && !(await readSettings()).autoUpdate) {
      log(`${check.latest} is out. Auto-update is off; run \`soopdoop update\` to install it.`);
      return;
    }
    target = check.latest;
  }
  log(`Updating to ${target}…`);
  const done = await applyUpdate(ROOT, target, defaultSteps(auto));
  log(`Updated v${done.from} → ${done.to}. What's new: ${releasePage(done.to)}`);
}

async function uninstall(): Promise<void> {
  await uninstallClaudeHooks();
  console.log(`· Removed the soopdoop hooks from ${tilde(claudeSettingsPath())}. Other hooks are untouched.`);
  const claude = Bun.which("claude");
  if (claude !== null) {
    Bun.spawnSync([claude, "mcp", "remove", "--scope", "user", "soopdoop"], { stdout: "pipe", stderr: "pipe" });
    console.log("· Removed the ask_operator tool from Claude Code.");
  }
  if (process.platform === "darwin") {
    for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) {
      await unload(spec.label);
      await removeFile(plistPath(spec.label)).catch(function () { /* already gone */ });
    }
    await removeApp();
    console.log("· Stopped the background rail, daemon, app and updater, and removed ~/Applications/soopdoop.app.");
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
  const files = ["rail.log", "daemon.log", "update.log"].map(function (f) { return path.join(home, "logs", f); });
  await Bun.spawn(["tail", "-n", "40", "-F", ...files], { stdout: "inherit", stderr: "inherit" }).exited;
}

const HELP = `soopdoop setup [--invite <code>] [--no-open]   install, build the app, run in the background
soopdoop status | version                       what is running, paired, hooked, which version
soopdoop open | logs                            show the HUD (the web rail if there is no app) · follow the logs
soopdoop update [--to <version>]                install the newest release (or move to one, also back)
soopdoop auto-update [on|off]                   whether new releases install themselves (on by default)
soopdoop start | stop | restart                 the background services
soopdoop uninstall                              remove the hooks, the background services, the app and the ask_operator tool
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
    case "version":
    case "--version":
      console.log(`v${await currentVersion(ROOT)}`);
      break;
    case "open":
      // Opening the running app shows the HUD (it handles reopen); without the app, the web rail.
      if (await Bun.file(appBinaryPath()).exists()) Bun.spawnSync(["open", appBundlePath()]);
      else await openInBrowser(RAIL_URL);
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
      for (const spec of serviceSpecs(ROOT, process.execPath, soopdoopHome())) {
        if (spec.port !== undefined) await restart(spec.label);
      }
      break;
    case "update":
      await update(rest);
      break;
    case "auto-update": {
      const value = rest[0];
      if (value !== "on" && value !== "off") {
        console.log(`Auto-update is ${(await readSettings()).autoUpdate ? "on" : "off"}. Change it with: soopdoop auto-update on|off`);
        break;
      }
      await writeSettings({ autoUpdate: value === "on" });
      console.log(value === "on"
        ? "Auto-update on: new releases install themselves within 6 hours."
        : "Auto-update off. The rail says when a release is out; `soopdoop update` installs it.");
      break;
    }
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
