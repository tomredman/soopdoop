// ABOUTME: The files in ~/.soopdoop: the pairing (config.json) and settings (settings.json), and how to read and write them.
// ABOUTME: Shared by the daemon, the CLI and the rail's local server, which writes the pairing when the rail pairs this machine.
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord } from "./state";

export interface Config {
  convexUrl: string;
  token: string;
  privateDirs: string[];
}

// SOOPDOOP_HOME exists so tests and a second daemon never touch the real config.
export function soopdoopHome(): string {
  return process.env.SOOPDOOP_HOME ?? path.join(homedir(), ".soopdoop");
}

export function configPath(home: string = soopdoopHome()): string {
  return path.join(home, "config.json");
}

export function parseConfig(raw: unknown): Config | null {
  if (!isRecord(raw) || typeof raw.convexUrl !== "string" || typeof raw.token !== "string") return null;
  const privateDirs = Array.isArray(raw.privateDirs)
    ? raw.privateDirs.filter(function (d): d is string { return typeof d === "string"; })
    : [];
  return { convexUrl: raw.convexUrl, token: raw.token, privateDirs };
}

// Null when this machine is not paired. Throws when the file is there but unreadable.
export async function readConfig(file: string = configPath()): Promise<Config | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const config = parseConfig(await f.json());
  if (config === null) throw new Error(`Bad config at ${file}. Pair this machine again from the rail.`);
  return config;
}

// The token lets anyone report presence as this hacker, so only the owner may read the file. Written to a temporary
// file first and renamed, so the daemon never reads half a file.
export async function writeConfig(config: Config, file: string = configPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

// Changes whenever the file is written; 0 when there is none. Lets the daemon notice a pairing without a restart.
export async function configStamp(file: string = configPath()): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

// Preferences, apart from the pairing so pairing again never resets them.
export interface Settings {
  // On unless turned off: the updater job installs new releases by itself.
  autoUpdate: boolean;
}

export function settingsPath(home: string = soopdoopHome()): string {
  return path.join(home, "settings.json");
}

export async function readSettings(file: string = settingsPath()): Promise<Settings> {
  try {
    const raw: unknown = await Bun.file(file).json();
    return { autoUpdate: !(isRecord(raw) && raw.autoUpdate === false) };
  } catch {
    return { autoUpdate: true };
  }
}

export async function writeSettings(settings: Settings, file: string = settingsPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await Bun.write(file, JSON.stringify(settings, null, 2) + "\n");
}

// An invite code from `soopdoop setup --invite`, waiting for the app's first sign-in to redeem it.
export function invitePath(home: string = soopdoopHome()): string {
  return path.join(home, "invite");
}
