import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyUpdate, checkForUpdate, compareVersions, currentVersion, isInstall, isNewer, newestTag, parseVersion, readUpdateState,
  remoteTags, requestUpdate, takeUpdateRequest, type UpdateSteps,
} from "./update";

// A throwaway "GitHub": a bare repo with release tags, and installs cloned from it. SOOPDOOP_HOME points at the
// temp folder, so ~/.soopdoop/app is <temp>/home/app.
let dir = "";
let origin = "";
let home = "";
const savedHome = process.env.SOOPDOOP_HOME;
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

async function release(src: string, version: string, tag: string = `v${version}`): Promise<void> {
  await writeFile(path.join(src, "package.json"), JSON.stringify({ name: "soopdoop", version }) + "\n");
  git(src, "add", "package.json");
  git(src, "commit", "-q", "-m", `release ${version}`);
  git(src, "tag", tag);
}

async function cloneAt(target: string, tag: string): Promise<string> {
  git(dir, "clone", "-q", origin, target);
  git(target, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", `refs/tags/${tag}`);
  return target;
}

function fakeSteps(fail: "install" | "setup" | null = null): UpdateSteps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async install(root) {
      calls.push(`install ${JSON.parse(await Bun.file(path.join(root, "package.json")).text()).version}`);
      return { ok: fail !== "install", output: "install output\nE404 some package" };
    },
    async setup(root) {
      calls.push(`setup ${JSON.parse(await Bun.file(path.join(root, "package.json")).text()).version}`);
      return { ok: fail !== "setup", output: "setup output\nport 47312 taken" };
    },
  };
}

beforeAll(async function () {
  dir = await mkdtemp(path.join(tmpdir(), "soopdoop-update-"));
  home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  process.env.SOOPDOOP_HOME = home;
  origin = path.join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const src = path.join(dir, "src");
  git(dir, "clone", "-q", origin, src);
  await release(src, "0.1.0");
  await release(src, "0.2.0");
  await release(src, "0.3.0", "v0.3.0-rc.1");
  git(src, "tag", "notes");
  git(src, "push", "-q", "origin", "HEAD:refs/heads/main", "--tags");
});

afterAll(async function () {
  if (savedHome === undefined) delete process.env.SOOPDOOP_HOME;
  else process.env.SOOPDOOP_HOME = savedHome;
  await rm(dir, { recursive: true, force: true });
});

describe("versions", function () {
  test("reads vX.Y.Z and X.Y.Z, nothing else", function () {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.10.0")).toEqual([0, 10, 0]);
    for (const bad of ["v1.2", "1.2.3-rc.1", "latest", "v1.2.3.4", ""]) expect(parseVersion(bad)).toBeNull();
  });

  test("compares numerically, not as text", function () {
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer(null, "0.1.0")).toBe(false);
  });

  test("the newest release tag ignores pre-releases and other tags", function () {
    expect(newestTag(["v0.2.0", "v0.10.0", "v0.9.1", "v1.0.0-rc.1", "notes", "1.5.0"])).toBe("v0.10.0");
    expect(newestTag(["notes"])).toBeNull();
  });
});

describe("updating an install", function () {
  test("finds the newest release on the remote and records it", async function () {
    const app = await cloneAt(path.join(home, "app"), "v0.1.0");
    expect(await isInstall(app)).toBe(true);
    expect((await remoteTags(app)).sort()).toEqual(["notes", "v0.1.0", "v0.2.0", "v0.3.0-rc.1"]);
    expect(await checkForUpdate(app)).toEqual({ current: "0.1.0", latest: "v0.2.0", newer: true });
    expect((await readUpdateState()).latest).toBe("v0.2.0");
  });

  test("moves to the release, installs, runs the new setup, and records it", async function () {
    const app = path.join(home, "app");
    const steps = fakeSteps();
    expect(await applyUpdate(app, "v0.2.0", steps)).toEqual({ from: "0.1.0", to: "v0.2.0" });
    expect(await currentVersion(app)).toBe("0.2.0");
    expect(steps.calls).toEqual(["install 0.2.0", "setup 0.2.0"]);
    expect(await readUpdateState()).toMatchObject({ updatedFrom: "0.1.0", updatedTo: "v0.2.0" });
  });

  test("puts the old version back when the new one fails to set up, and says why", async function () {
    const app = path.join(home, "app");
    const steps = fakeSteps("setup");
    await expect(applyUpdate(app, "v0.1.0", steps)).rejects.toThrow("failed and was undone: setup: setup output port 47312 taken");
    expect(await currentVersion(app)).toBe("0.2.0");
    // The new version was tried, then the old one was installed and set up again.
    expect(steps.calls).toEqual(["install 0.1.0", "setup 0.1.0", "install 0.2.0", "setup 0.2.0"]);
    expect((await readUpdateState()).error).toContain("Update to v0.1.0 failed and was undone");
    // A good update clears the problem.
    await applyUpdate(app, "v0.1.0", fakeSteps());
    expect((await readUpdateState()).error).toBeUndefined();
    await applyUpdate(app, "v0.2.0", fakeSteps());
  });

  test("does not touch local changes, or anything that is not a release tag", async function () {
    const app = path.join(home, "app");
    await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "soopdoop", version: "9.9.9" }) + "\n");
    await expect(applyUpdate(app, "v0.1.0", fakeSteps())).rejects.toThrow("local changes");
    git(app, "checkout", "-q", "--", "package.json");
    await expect(applyUpdate(app, "notes", fakeSteps())).rejects.toThrow("not a release tag");
    await expect(applyUpdate(app, "v0.3.0-rc.1", fakeSteps())).rejects.toThrow("not a release tag");
  });

  test("runs one update at a time, and clears a lock left by a crash", async function () {
    const app = path.join(home, "app");
    const lock = path.join(home, "update.lock");
    await writeFile(lock, "123");
    await expect(applyUpdate(app, "v0.1.0", fakeSteps())).rejects.toThrow("Another soopdoop update is running");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, old, old);
    await applyUpdate(app, "v0.1.0", fakeSteps());
    expect(await currentVersion(app)).toBe("0.1.0");
    expect(await Bun.file(lock).exists()).toBe(false);
  });

  test("a development checkout on a branch is not an install; one on a release tag elsewhere is", async function () {
    const dev = path.join(dir, "dev");
    git(dir, "clone", "-q", origin, dev);
    expect(await isInstall(dev)).toBe(false);
    const pinned = await cloneAt(path.join(dir, "pinned"), "v0.1.0");
    expect(await isInstall(pinned)).toBe(true);
  });

  test("the rail's update request is taken once", async function () {
    await requestUpdate();
    expect(await takeUpdateRequest()).toBe(true);
    expect(await takeUpdateRequest()).toBe(false);
  });
});
