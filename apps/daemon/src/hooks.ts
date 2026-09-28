// ABOUTME: Installs the soopdoop lifecycle hooks into Claude Code's user settings, beside any hooks Superset installed.
// ABOUTME: Every hook is one command: `soopdoop hook <event>`, which posts the harness payload to the local daemon.
import { homedir } from "node:os";
import path from "node:path";

export const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification", "SessionEnd"] as const;

const MARKER = "soopdoop";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function claudeSettingsPath(): string {
  return path.join(homedir(), ".claude", "settings.json");
}

function isOurs(entry: HookEntry): boolean {
  return entry.command.includes(MARKER + " hook ");
}

// Adds our hook to each event, once. Leaves other hooks (Superset's included) untouched.
export function withSoopdoopHooks(settings: ClaudeSettings, command: string): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  for (const event of CLAUDE_EVENTS) {
    const groups: HookGroup[] = (hooks[event] ?? []).map(function (g) {
      return { ...g, hooks: g.hooks.filter(function (h) { return !isOurs(h); }) };
    }).filter(function (g) { return g.hooks.length > 0; });
    groups.push({ hooks: [{ type: "command", command: `${command} hook ${event}`, timeout: 5 }] });
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

export async function installClaudeHooks(command: string, file: string = claudeSettingsPath()): Promise<void> {
  const f = Bun.file(file);
  const settings: ClaudeSettings = (await f.exists()) ? ((await f.json()) as ClaudeSettings) : {};
  await Bun.write(file, JSON.stringify(withSoopdoopHooks(settings, command), null, 2) + "\n");
}

export async function uninstallClaudeHooks(file: string = claudeSettingsPath()): Promise<void> {
  const f = Bun.file(file);
  if (!(await f.exists())) return;
  const settings = (await f.json()) as ClaudeSettings;
  await Bun.write(file, JSON.stringify(withoutSoopdoopHooks(settings), null, 2) + "\n");
}
