// ABOUTME: Installs soopdoop's lifecycle hooks into Grok (its own file, <GROK_HOME>/hooks/soopdoop.json, beside Superset's) and
// ABOUTME: finds the real grok binary. Grok reads every *.json in that folder, so uninstalling removes our file and nothing else.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hasOurHooks, installHookFile, readHookFile, uninstallHookFile, type OurHook } from "./hookfile";
import type { CommandFor } from "./hooks";

function set(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function grokHome(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return set(env.GROK_HOME) ?? path.join(home, ".grok");
}

export function grokHooksPath(home: string = grokHome()): string {
  return path.join(home, "hooks", "soopdoop.json");
}

// The Grok events soopdoop listens to. A turn that fails or is cancelled ends with StopFailure or StopCancelled instead of
// Stop. Notification also fires when idle, so only the two that mean "waiting for you" are taken, as Superset does.
export const GROK_EVENTS: readonly { event: string; matcher?: string }[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse" },
  { event: "Stop" },
  { event: "StopFailure" },
  { event: "StopCancelled" },
  { event: "Notification", matcher: "^(permission_prompt|elicitation_dialog)$" },
  { event: "SessionEnd" },
];

export function grokHooks(commandFor: CommandFor): OurHook[] {
  return GROK_EVENTS.map(function (e) {
    const hook: OurHook = { event: e.event, command: commandFor(e.event), timeout: 5 };
    if (e.matcher !== undefined) hook.matcher = e.matcher;
    return hook;
  });
}

// Returns the path of the backup of an earlier soopdoop.json, or null when there was none (the usual case).
export async function installGrokHooks(commandFor: CommandFor, file: string = grokHooksPath()): Promise<string | null> {
  return await installHookFile(file, grokHooks(commandFor));
}

export async function uninstallGrokHooks(file: string = grokHooksPath()): Promise<boolean> {
  return await uninstallHookFile(file, true);
}

export async function grokHooksInstalled(commandFor: CommandFor, file: string = grokHooksPath()): Promise<boolean> {
  const hooks = await readHookFile(file).catch(function () { return null; });
  return hooks !== null && hasOurHooks(hooks, grokHooks(commandFor));
}

// The real grok binary: on PATH, else where its installer puts it. Never Superset's wrapper in ~/.superset/bin, which would
// report a fork to Superset as a new agent.
export function findGrok(
  home: string = homedir(),
  pathVar: string = process.env.PATH ?? "",
  extra: string[] = ["/opt/homebrew/bin/grok", "/usr/local/bin/grok"],
): string | null {
  const dirs = pathVar.split(":").filter(function (d) { return d !== "" && !d.startsWith(path.join(home, ".superset")); });
  const places = [
    ...dirs.map(function (d) { return path.join(d, "grok"); }),
    path.join(home, ".grok", "bin", "grok"),
    path.join(home, ".local", "bin", "grok"),
    ...extra,
  ];
  return places.find(function (p) { return existsSync(p); }) ?? null;
}
