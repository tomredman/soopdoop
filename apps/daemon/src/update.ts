// ABOUTME: Releases and updates. An install is a git checkout of a release tag (vX.Y.Z) in ~/.soopdoop/app. Updating checks
// ABOUTME: out the newer tag, installs packages, and runs setup from the new code; any failure puts the old version back.
import { realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { soopdoopHome } from "./config";
import { isRecord } from "./state";

export const REPO_PAGE = "https://github.com/tomredman/soopdoop";

export type Version = [number, number, number];

// "v1.2.3" or "1.2.3". Pre-release and build suffixes are not releases here.
export function parseVersion(s: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Version, b: Version): number {
  const [a0, a1, a2] = a;
  const [b0, b1, b2] = b;
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  return a2 - b2;
}

export function tagFor(v: Version): string {
  return `v${v[0]}.${v[1]}.${v[2]}`;
}

// The newest release tag (vX.Y.Z) among tag names. Anything else is ignored.
export function newestTag(tags: string[]): string | null {
  let best: { tag: string; v: Version } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    const v = parseVersion(tag);
    if (v === null) continue;
    if (best === null || compareVersions(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag ?? null;
}

// True when `latest` is a newer release than `current`.
export function isNewer(latest: string | null | undefined, current: string): boolean {
  const l = latest === null || latest === undefined ? null : parseVersion(latest);
  const c = parseVersion(current);
  return l !== null && c !== null && compareVersions(l, c) > 0;
}

export function releasePage(tag: string): string {
  return `${REPO_PAGE}/releases/tag/${tag}`;
}

async function sh(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

async function git(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return await sh(["git", "-C", root, ...args], root);
}

async function mustGit(root: string, args: string[]): Promise<string> {
  const res = await git(root, args);
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.err.trim() || `exit ${res.code}`}`);
  return res.out.trim();
}

// The version this checkout is: the root package.json, which the release script bumps.
export async function currentVersion(root: string): Promise<string> {
  const raw: unknown = await Bun.file(path.join(root, "package.json")).json();
  if (!isRecord(raw) || typeof raw.version !== "string") throw new Error(`No version in ${root}/package.json`);
  return raw.version;
}

export function installDir(): string {
  return path.join(soopdoopHome(), "app");
}

// An install is the checkout setup made in ~/.soopdoop/app, or any checkout sitting on a release tag.
// A development checkout on a branch is left alone: update it with git.
export async function isInstall(root: string): Promise<boolean> {
  const [here, install] = await Promise.all([
    realpath(root).catch(function () { return root; }),
    realpath(installDir()).catch(function () { return installDir(); }),
  ]);
  if (here === install) return true;
  if ((await git(root, ["symbolic-ref", "-q", "HEAD"])).code === 0) return false;
  const tag = await git(root, ["describe", "--tags", "--exact-match", "HEAD"]);
  return tag.code === 0 && parseVersion(tag.out) !== null;
}

// Release tags on GitHub, read without downloading anything.
export async function remoteTags(root: string): Promise<string[]> {
  const out = await mustGit(root, ["ls-remote", "--tags", "--refs", "origin"]);
  return out.split("\n").flatMap(function (line) {
    const ref = line.split("\t")[1];
    return ref === undefined ? [] : [ref.replace(/^refs\/tags\//, "")];
  });
}

// What the rail and `soopdoop status` show about updates. Written by checks and updates, read by anyone.
export interface UpdateState {
  latest?: string;
  checkedAt?: number;
  updatedFrom?: string;
  updatedTo?: string;
  updatedAt?: number;
  error?: string;
}

export function updateStatePath(): string {
  return path.join(soopdoopHome(), "update.json");
}

export async function readUpdateState(): Promise<UpdateState> {
  try {
    const raw: unknown = await Bun.file(updateStatePath()).json();
    if (!isRecord(raw)) return {};
    const state: UpdateState = {};
    if (typeof raw.latest === "string") state.latest = raw.latest;
    if (typeof raw.checkedAt === "number") state.checkedAt = raw.checkedAt;
    if (typeof raw.updatedFrom === "string") state.updatedFrom = raw.updatedFrom;
    if (typeof raw.updatedTo === "string") state.updatedTo = raw.updatedTo;
    if (typeof raw.updatedAt === "number") state.updatedAt = raw.updatedAt;
    if (typeof raw.error === "string") state.error = raw.error;
    return state;
  } catch {
    return {};
  }
}

// Merges into the state file. A key set to undefined is removed.
export async function writeUpdateState(patch: Partial<Record<keyof UpdateState, string | number | undefined>>): Promise<void> {
  const next: Record<string, unknown> = { ...(await readUpdateState()), ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  await Bun.write(updateStatePath(), JSON.stringify(next, null, 2) + "\n");
}

export async function checkForUpdate(root: string): Promise<{ current: string; latest: string | null; newer: boolean }> {
  const current = await currentVersion(root);
  const latest = newestTag(await remoteTags(root));
  await writeUpdateState({ latest: latest ?? undefined, checkedAt: Date.now() });
  return { current, latest, newer: isNewer(latest, current) };
}

// The rail's "Update now" leaves this file for the updater job, which updates even when auto-update is off.
export function updateRequestPath(): string {
  return path.join(soopdoopHome(), "update-requested");
}

export async function requestUpdate(): Promise<void> {
  await Bun.write(updateRequestPath(), String(Date.now()));
}

// True once per request: the file is removed when read.
export async function takeUpdateRequest(): Promise<boolean> {
  try {
    await unlink(updateRequestPath());
    return true;
  } catch {
    return false;
  }
}

const LOCK_STALE_MS = 15 * 60 * 1000;

function lockPath(): string {
  return path.join(soopdoopHome(), "update.lock");
}

export async function updateRunning(): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath())).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// One update at a time, across the CLI, the updater job and the rail's button.
async function takeLock(): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath(), String(process.pid), { flag: "wx" });
      return async function () { await unlink(lockPath()).catch(function () { /* already gone */ }); };
    } catch {
      if (await updateRunning()) throw new Error("Another soopdoop update is running. Try again in a few minutes.");
      // A lock left by a crashed update.
      await unlink(lockPath()).catch(function () { /* raced with another cleaner */ });
    }
  }
  throw new Error("Could not take the update lock.");
}

// The parts of an update that run outside git. Tests replace them.
export interface UpdateSteps {
  install(root: string): Promise<{ ok: boolean; output: string }>;
  setup(root: string): Promise<{ ok: boolean; output: string }>;
}

export function defaultSteps(fromUpdater: boolean): UpdateSteps {
  return {
    async install(root) {
      const res = await sh([process.execPath, "install"], root);
      return { ok: res.code === 0, output: res.out + res.err };
    },
    async setup(root) {
      // Runs the new version's own setup, so hooks and services match the new code. The updater job cannot reload
      // itself while it runs, so it asks setup to leave it alone; its plist is rewritten for the next load.
      const args = [process.execPath, path.join(root, "apps", "daemon", "src", "cli.ts"), "setup", "--no-open", "--quiet"];
      if (fromUpdater) args.push("--keep-updater");
      const res = await sh(args, root);
      return { ok: res.code === 0, output: res.out + res.err };
    },
  };
}

// Moves the install at `root` to release `tag`. On any failure it goes back to where it was and says why.
export async function applyUpdate(root: string, tag: string, steps: UpdateSteps): Promise<{ from: string; to: string }> {
  if (parseVersion(tag) === null || !tag.startsWith("v")) throw new Error(`${tag} is not a release tag like v1.2.3.`);
  const release = await takeLock();
  try {
    const dirty = await mustGit(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty !== "") throw new Error(`${root} has local changes, so soopdoop will not replace them.`);
    const from = await currentVersion(root);
    const before = await mustGit(root, ["rev-parse", "HEAD"]);
    await mustGit(root, ["fetch", "--quiet", "--tags", "--force", "origin"]);
    await mustGit(root, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", `refs/tags/${tag}`]);

    async function putBack(why: string): Promise<never> {
      await mustGit(root, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", before]);
      await steps.install(root);
      await steps.setup(root);
      await writeUpdateState({ error: `Update to ${tag} failed and was undone: ${why}` });
      throw new Error(`Update to ${tag} failed and was undone: ${why}`);
    }

    const installed = await steps.install(root);
    if (!installed.ok) await putBack(`bun install: ${installed.output.trim().split("\n").slice(-3).join(" ")}`);
    const set = await steps.setup(root);
    if (!set.ok) await putBack(`setup: ${set.output.trim().split("\n").slice(-3).join(" ")}`);
    await writeUpdateState({ updatedFrom: from, updatedTo: tag, updatedAt: Date.now(), error: undefined });
    return { from, to: tag };
  } finally {
    await release();
  }
}
