// ABOUTME: Installs the soopdoop lifecycle hooks into Claude Code's user settings, beside Superset's, and finds the claude
// ABOUTME: command. Each hook runs hook.ts guarded, so a missing file or a failure never reaches the harness.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord } from "./state";

export const CLAUDE_EVENTS: readonly string[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification", "SessionEnd"];

const MARKER = /(^|\s|\/)soopdoop(\.ts)?(\s|$)/;

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

// Builds the command Claude Code runs for one event.
export type CommandFor = (event: string) => string;

export function claudeSettingsPath(): string {
  return path.join(homedir(), ".claude", "settings.json");
}

// The claude command: on PATH in a terminal, else where its installers put it. The updater runs with launchd's short PATH.
export function findClaude(home: string = homedir(), onPath: string | null = Bun.which("claude"), extra: string[] = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]): string | null {
  if (onPath !== null) return onPath;
  const places = [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), ...extra];
  return places.find(function (p) { return existsSync(p); }) ?? null;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The default hook: run hook.ts with bun if the file is still there. `|| true` keeps every exit at 0,
// so a moved or deleted checkout never shows the hacker a hook error.
export function guardedHook(bunPath: string, hookPath: string): CommandFor {
  return function (event) {
    return `[ -f ${shellQuote(hookPath)} ] && ${shellQuote(bunPath)} ${shellQuote(hookPath)} ${event} || true`;
  };
}

// The older form: any command prefix followed by `hook <event>`, e.g. `soopdoop hook Stop`.
export function prefixedHook(prefix: string): CommandFor {
  return function (event) {
    return `${prefix} hook ${event}`;
  };
}

// Ours: runs the daemon's hook.ts, or runs the soopdoop CLI with `hook` (bare `soopdoop` or the cli.ts path).
function isOurs(entry: HookEntry): boolean {
  if (entry.command.includes("/daemon/src/hook.ts")) return true;
  return entry.command.includes(" hook ") && (MARKER.test(entry.command) || entry.command.includes("/daemon/src/cli.ts "));
}

function parseEntry(raw: unknown): HookEntry | null {
  if (!isRecord(raw) || raw.type !== "command" || typeof raw.command !== "string") return null;
  const entry: HookEntry = { type: "command", command: raw.command };
  if (typeof raw.timeout === "number") entry.timeout = raw.timeout;
  return entry;
}

// Reads settings.json without trusting its shape. Anything under `hooks` we cannot read exactly makes us refuse
// to touch the file: rewriting a hacker's settings from a guess could drop hooks they rely on.
export function parseSettings(raw: unknown): ClaudeSettings {
  if (!isRecord(raw)) throw new Error("settings.json is not a JSON object");
  const { hooks: rawHooks, ...rest } = raw;
  if (rawHooks === undefined) return { ...rest };
  if (!isRecord(rawHooks)) throw new Error("settings.json: `hooks` is not an object");
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, rawGroups] of Object.entries(rawHooks)) {
    if (!Array.isArray(rawGroups)) throw new Error(`settings.json: hooks.${event} is not a list`);
    const groups: HookGroup[] = [];
    for (const rawGroup of rawGroups) {
      if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks)) throw new Error(`settings.json: a hooks.${event} entry has no hooks list`);
      const entries: HookEntry[] = [];
      for (const rawEntry of rawGroup.hooks) {
        const entry = parseEntry(rawEntry);
        if (entry === null) throw new Error(`settings.json: a hooks.${event} hook is not a command hook; leaving the file alone`);
        entries.push(entry);
      }
      const group: HookGroup = { hooks: entries };
      if (typeof rawGroup.matcher === "string") group.matcher = rawGroup.matcher;
      groups.push(group);
    }
    hooks[event] = groups;
  }
  return { ...rest, hooks };
}

// Adds our hook to each event, once, replacing any older soopdoop hook. Leaves other hooks (Superset's included) untouched.
export function withSoopdoopHooks(settings: ClaudeSettings, commandFor: CommandFor): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  for (const event of CLAUDE_EVENTS) {
    const groups: HookGroup[] = (hooks[event] ?? [])
      .map(function (g) {
        return { ...g, hooks: g.hooks.filter(function (h) { return !isOurs(h); }) };
      })
      .filter(function (g) { return g.hooks.length > 0; });
    groups.push({ hooks: [{ type: "command", command: commandFor(event), timeout: 5 }] });
    hooks[event] = groups;
  }
  return { ...settings, hooks };
}

export function withoutSoopdoopHooks(settings: ClaudeSettings): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups
      .map(function (g) {
        return { ...g, hooks: g.hooks.filter(function (h) { return !isOurs(h); }) };
      })
      .filter(function (g) { return g.hooks.length > 0; });
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...settings, hooks };
}

async function readSettings(file: string): Promise<ClaudeSettings> {
  const f = Bun.file(file);
  if (!(await f.exists())) return {};
  const raw: unknown = await f.json();
  return parseSettings(raw);
}

export async function installClaudeHooks(commandFor: CommandFor, file: string = claudeSettingsPath()): Promise<void> {
  const settings = await readSettings(file);
  await Bun.write(file, JSON.stringify(withSoopdoopHooks(settings, commandFor), null, 2) + "\n");
}

export async function uninstallClaudeHooks(file: string = claudeSettingsPath()): Promise<void> {
  if (!(await Bun.file(file).exists())) return;
  const settings = await readSettings(file);
  await Bun.write(file, JSON.stringify(withoutSoopdoopHooks(settings), null, 2) + "\n");
}
