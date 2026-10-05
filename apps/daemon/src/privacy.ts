// ABOUTME: Which agents are private: those whose folder, or the repository their folder belongs to, is inside a folder in
// ABOUTME: privateDirs. Superset and Claude Code worktrees belong to their main repository, so one entry covers all of them.
import path from "node:path";

let gitReady: boolean | null = null;

// On a Mac without Xcode's command line tools, /usr/bin/git opens Apple's install dialog: check first, once.
function canRunGit(): boolean {
  if (gitReady === null) {
    gitReady = process.platform === "darwin"
      ? Bun.spawnSync(["xcode-select", "-p"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
      : Bun.which("git") !== null;
  }
  return gitReady;
}

export type Git = (args: string[]) => string | null;

function runGit(args: string[]): string | null {
  if (!canRunGit()) return null;
  const res = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = res.stdout.toString().trim();
  return res.exitCode === 0 && out !== "" ? out : null;
}

// The main repository a folder belongs to: for a worktree, the repository it was made from. Null outside git.
export function repoRoot(cwd: string, git: Git = runGit): string | null {
  const common = git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common === null) return null;
  // <repo>/.git for a repository and all its worktrees. A bare repository has no folder to name.
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

export function inside(folder: string, dir: string): boolean {
  return folder === dir || folder.startsWith(dir + "/");
}

export function isPrivate(cwd: string | undefined, repo: string | undefined, privateDirs: string[]): boolean {
  return privateDirs.some(function (d) {
    return (cwd !== undefined && inside(cwd, d)) || (repo !== undefined && inside(repo, d));
  });
}

// The folders to keep private for one agent, or to stop keeping private. Making it private adds its repository (or its
// folder outside git); making it open again removes every entry that covers it.
export function withPrivacy(privateDirs: string[], cwd: string | undefined, repo: string | undefined, makePrivate: boolean): string[] {
  if (makePrivate) {
    const folder = repo ?? cwd;
    if (folder === undefined || isPrivate(cwd, repo, privateDirs)) return privateDirs;
    return [...privateDirs, folder];
  }
  return privateDirs.filter(function (d) { return !isPrivate(cwd, repo, [d]); });
}
