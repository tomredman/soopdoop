// ABOUTME: Adds and removes soopdoop's entries in a harness's hooks file ({ "hooks": { Event: [{ matcher?, hooks: [...] }] } }), the
// ABOUTME: shape Codex and Grok share with Claude Code. Every other key, group and entry is kept exactly as it was, whatever its type.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./state";

export interface OurHook {
  event: string;
  command: string;
  timeout: number;
  matcher?: string;
}

export type HookFile = Record<string, unknown>;

// Ours run the daemon's hook.ts; nothing else does.
export function isOurEntry(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.command === "string" && entry.command.includes("/daemon/src/hook.ts");
}

// The file's hooks by event. Anything that is not an object of lists makes us refuse to touch the file: rewriting it from a
// guess could drop hooks someone relies on.
function hooksOf(file: HookFile, name: string): Record<string, unknown[]> {
  if (file.hooks === undefined) return {};
  if (!isRecord(file.hooks)) throw new Error(`${name}: \`hooks\` is not an object; leaving the file alone`);
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${name}: hooks.${event} is not a list; leaving the file alone`);
    hooks[event] = groups;
  }
  return hooks;
}

// The groups of one event without our entries. A group left with no entries goes, unless it had none to begin with.
function withoutOurs(groups: unknown[]): unknown[] {
  return groups.flatMap(function (group) {
    if (!isRecord(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurEntry)) return [group];
    const kept = group.hooks.filter(function (h) { return !isOurEntry(h); });
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
}

export function withoutOurHooks(file: HookFile, name: string = "hooks file"): HookFile {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooksOf(file, name))) {
    const kept = withoutOurs(groups);
    // An event whose only entries were ours goes; one that was already empty stays as it was.
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}

// Adds one group per hook of ours, after removing any older ones, so installing twice changes nothing.
export function withOurHooks(file: HookFile, ours: OurHook[], name: string = "hooks file"): HookFile {
  const hooks = hooksOf(withoutOurHooks(file, name), name);
  for (const hook of ours) {
    const group: Record<string, unknown> = { hooks: [{ type: "command", command: hook.command, timeout: hook.timeout }] };
    if (hook.matcher !== undefined) group.matcher = hook.matcher;
    hooks[hook.event] = [...(hooks[hook.event] ?? []), group];
  }
  return { ...file, hooks };
}

// Whether the file has every one of our hooks, exactly as given.
export function hasOurHooks(file: HookFile, ours: OurHook[]): boolean {
  const hooks = isRecord(file.hooks) ? file.hooks : {};
  return ours.every(function (hook) {
    const groups = hooks[hook.event];
    return Array.isArray(groups) && groups.some(function (g) {
      return isRecord(g) && Array.isArray(g.hooks) && g.hooks.some(function (h) { return isRecord(h) && h.command === hook.command; });
    });
  });
}

export async function readHookFile(file: string): Promise<HookFile | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await f.text());
  } catch {
    throw new Error(`${file} is not JSON; leaving it alone`);
  }
  if (!isRecord(raw)) throw new Error(`${file} is not a JSON object; leaving it alone`);
  return raw;
}

// Whether the file holds nothing but our hooks (soopdoop's own Grok file, after the first setup).
function onlyOurs(file: HookFile): boolean {
  const rest = withoutOurHooks(file);
  const hooks = isRecord(rest.hooks) ? rest.hooks : {};
  return Object.keys(hooks).length === 0 && Object.keys(rest).every(function (k) { return k === "hooks"; });
}

// Saves the file as it was before soopdoop first touched it, once. Null when there was no file, or nothing but ours in it.
async function backUp(file: string, before: HookFile | null): Promise<string | null> {
  if (before === null || onlyOurs(before)) return null;
  const backup = `${file}.before-soopdoop`;
  if (!(await Bun.file(backup).exists())) await Bun.write(backup, Bun.file(file));
  return backup;
}

// Installs our hooks into the file, beside whatever is there. Returns the backup's path, or null when there was nothing of
// anyone else's to keep.
export async function installHookFile(file: string, ours: OurHook[]): Promise<string | null> {
  const before = await readHookFile(file);
  const after = withOurHooks(before ?? {}, ours, file);
  const backup = await backUp(file, before);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify(after, null, 2) + "\n");
  return backup;
}

// Removes only our hooks. A file that held nothing but ours (`ownFile`) is deleted instead of left empty.
export async function uninstallHookFile(file: string, ownFile: boolean = false): Promise<boolean> {
  const before = await readHookFile(file);
  if (before === null) return false;
  const after = withoutOurHooks(before, file);
  const left = isRecord(after.hooks) ? Object.keys(after.hooks).length : 0;
  if (ownFile && left === 0 && Object.keys(after).every(function (k) { return k === "hooks"; })) {
    await rm(file, { force: true });
    return true;
  }
  await Bun.write(file, JSON.stringify(after, null, 2) + "\n");
  return true;
}
