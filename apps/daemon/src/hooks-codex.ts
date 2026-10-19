// ABOUTME: Installs soopdoop's lifecycle hooks into Codex (<CODEX_HOME>/hooks.json, beside Superset's) and finds the real codex
// ABOUTME: binary. Codex trusts a hook by a hash of its definition, so each hook's command and timeout here stay the same across releases.
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hasOurHooks, installHookFile, readHookFile, uninstallHookFile, type OurHook } from "./hookfile";
import type { CommandFor } from "./hooks";

function set(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function codexHome(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return set(env.CODEX_HOME) ?? path.join(home, ".codex");
}

export function codexHooksPath(home: string = codexHome()): string {
  return path.join(home, "hooks.json");
}

// The Codex events soopdoop listens to, and how long each hook may take. Codex has no Notification event: PermissionRequest
// is its "waiting for you", and Interrupt ends a turn without Stop. Codex allows SessionEnd and Interrupt 3 seconds at most.
export const CODEX_EVENTS: readonly { event: string; timeout: number }[] = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "PreToolUse", timeout: 5 },
  { event: "PermissionRequest", timeout: 5 },
  { event: "Stop", timeout: 5 },
  { event: "Interrupt", timeout: 3 },
  { event: "SessionEnd", timeout: 3 },
];

export function codexHooks(commandFor: CommandFor): OurHook[] {
  return CODEX_EVENTS.map(function (e) { return { event: e.event, command: commandFor(e.event), timeout: e.timeout }; });
}

// Returns the path of the backup of the file as it was before soopdoop, or null when Codex had no hooks file yet.
export async function installCodexHooks(commandFor: CommandFor, file: string = codexHooksPath()): Promise<string | null> {
  return await installHookFile(file, codexHooks(commandFor));
}

export async function uninstallCodexHooks(file: string = codexHooksPath()): Promise<boolean> {
  return await uninstallHookFile(file);
}

export async function codexHooksInstalled(commandFor: CommandFor, file: string = codexHooksPath()): Promise<boolean> {
  const hooks = await readHookFile(file).catch(function () { return null; });
  return hooks !== null && hasOurHooks(hooks, codexHooks(commandFor));
}

// The npm package's name for this Mac's binary and the folder it sits in, as Codex's own launcher (bin/codex.js) names them.
function codexTarget(): { pkg: string; triple: string } {
  const arm = process.arch === "arm64";
  if (process.platform === "linux") return { pkg: `codex-linux-${arm ? "arm64" : "x64"}`, triple: `${arm ? "aarch64" : "x86_64"}-unknown-linux-musl` };
  return { pkg: `codex-darwin-${arm ? "arm64" : "x64"}`, triple: `${arm ? "aarch64" : "x86_64"}-apple-darwin` };
}

function startsWithNodeShebang(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    const head = buf.subarray(0, n).toString("utf8");
    return head.startsWith("#!") && head.split("\n")[0]?.includes("node") === true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// npm installs `codex` as a node script that starts a native binary. The daemon runs with launchd's short PATH, where node is
// often missing, so it runs that binary itself. Any other file is the binary. Null when the launcher's binary is not there.
export function nativeCodex(file: string): string | null {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return null;
  }
  if (!startsWithNodeShebang(real)) return real;
  // <node_modules>/@openai/codex/bin/codex.js: the binary is in the platform package, nested or beside it, or (older
  // packages) in the package's own vendor folder.
  const root = path.dirname(path.dirname(real));
  const { pkg, triple } = codexTarget();
  const candidates = [
    path.join(root, "node_modules", "@openai", pkg, "vendor", triple, "bin", "codex"),
    path.join(path.dirname(root), pkg, "vendor", triple, "bin", "codex"),
    path.join(root, "vendor", triple, "bin", "codex"),
    path.join(root, "vendor", triple, "codex", "codex"),
  ];
  return candidates.find(function (c) { return existsSync(c); }) ?? null;
}

// The real codex binary: on PATH, else where its installers put it, last the one inside the ChatGPT desktop app. Never
// Superset's wrapper in ~/.superset/bin, which would report a fork to Superset as a new agent.
export function findCodex(
  home: string = homedir(),
  pathVar: string = process.env.PATH ?? "",
  extra: string[] = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ],
): string | null {
  const dirs = pathVar.split(":").filter(function (d) { return d !== "" && !d.startsWith(path.join(home, ".superset")); });
  const places = [
    ...dirs.map(function (d) { return path.join(d, "codex"); }),
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".bun", "bin", "codex"),
    path.join(home, ".npm-global", "bin", "codex"),
    ...extra,
  ];
  for (const place of places) {
    if (!existsSync(place)) continue;
    const binary = nativeCodex(place);
    if (binary !== null) return binary;
  }
  return null;
}
