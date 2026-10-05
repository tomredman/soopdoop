import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inside, isPrivate, repoRoot, withPrivacy } from "./privacy";
import { apply, reapplyPrivacy, type Subset } from "./state";

const dirs: string[] = [];
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

describe("private folders", function () {
  test("a worktree belongs to the repository it was made from, as Superset's workspaces do", async function () {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "soopdoop-privacy-")));
    dirs.push(dir);
    const repo = path.join(dir, "Spend-Saver");
    Bun.spawnSync(["git", "init", "-q", repo]);
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start");
    const worktree = path.join(dir, "worktrees", "Spend Saver", "eel-027ed796");
    git(repo, "worktree", "add", "-q", worktree);
    expect(repoRoot(repo)).toBe(repo);
    expect(repoRoot(worktree)).toBe(repo);
    expect(repoRoot(path.join(dir, "worktrees"))).toBeNull();
    // A bare repository has no folder to keep private.
    expect(repoRoot("/x", function () { return "/srv/thing.git"; })).toBeNull();
  });

  test("an agent is private when its folder or its repository is inside a private folder", function () {
    expect(inside("/a/b", "/a")).toBe(true);
    expect(inside("/ab", "/a")).toBe(false);
    expect(isPrivate("/wt/Spend Saver/eel", "/p/Spend-Saver", ["/p/Spend-Saver"])).toBe(true);
    expect(isPrivate("/p/vibes", "/p/vibes", ["/p/Spend-Saver"])).toBe(false);
    expect(isPrivate(undefined, undefined, ["/p"])).toBe(false);
  });

  test("the switch adds the repository, and turning it off removes whatever covered the agent", function () {
    expect(withPrivacy([], "/wt/eel", "/p/Spend-Saver", true)).toEqual(["/p/Spend-Saver"]);
    expect(withPrivacy([], "/tmp/scratch", undefined, true)).toEqual(["/tmp/scratch"]);
    expect(withPrivacy(["/p"], "/wt/eel", "/p/Spend-Saver", true)).toEqual(["/p"]);
    expect(withPrivacy(["/p", "/wt/eel", "/q"], "/wt/eel", "/p/Spend-Saver", false)).toEqual(["/q"]);
  });

  test("agents take the repository's privacy, and change when the list changes", function () {
    const subset: Subset = new Map();
    function repoOf(cwd: string): string | undefined {
      return cwd.startsWith("/wt/Spend Saver/") ? "/p/Spend-Saver" : undefined;
    }
    apply(subset, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/wt/Spend Saver/eel" }, 1, ["/p/Spend-Saver"], repoOf);
    apply(subset, { hook_event_name: "SessionStart", session_id: "s2", cwd: "/p/vibes" }, 1, ["/p/Spend-Saver"], repoOf);
    expect(subset.get("s1")).toMatchObject({ open: false, repo: "/p/Spend-Saver" });
    expect(subset.get("s2")?.open).toBe(true);
    expect(reapplyPrivacy(subset, ["/p/vibes"])).toBe(true);
    expect([subset.get("s1")?.open, subset.get("s2")?.open]).toEqual([true, false]);
    expect(reapplyPrivacy(subset, ["/p/vibes"])).toBe(false);
  });
});
