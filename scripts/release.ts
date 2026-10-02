#!/usr/bin/env bun
// ABOUTME: Cuts a soopdoop release: checks, deploys the backend to production, bumps the version, writes CHANGELOG.md,
// ABOUTME: tags, pushes to main, and publishes a GitHub release. `bun run release <patch|minor|major> [--dry-run]`.
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const CONVEX_DIR = path.join(ROOT, "packages", "convex");
const REPO = "tomredman/soopdoop";
const INSTALL_LINE = "curl -fsSL https://raw.githubusercontent.com/tomredman/soopdoop/main/install.sh | bash";

export type Bump = "patch" | "minor" | "major";

export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) throw new Error(`package.json version ${version} is not X.Y.Z.`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Commit subjects since the last release, grouped by their `type(scope): subject` type. Release commits are left out.
export function releaseNotes(subjects: string[]): string {
  const added: string[] = [];
  const fixed: string[] = [];
  const docs: string[] = [];
  const other: string[] = [];
  for (const subject of subjects) {
    if (subject.startsWith("chore(release)")) continue;
    const m = /^(\w+)(?:\(([^)]*)\))?!?: (.+)$/.exec(subject);
    const line = m === null ? `- ${subject}` : `- ${m[3]}${m[2] === undefined ? "" : ` (${m[2]})`}`;
    const type = m?.[1];
    if (type === "feat") added.push(line);
    else if (type === "fix") fixed.push(line);
    else if (type === "docs") docs.push(line);
    else other.push(line);
  }
  const sections: string[] = [];
  if (added.length > 0) sections.push(["### New", ...added].join("\n"));
  if (fixed.length > 0) sections.push(["### Fixes", ...fixed].join("\n"));
  if (docs.length > 0) sections.push(["### Docs", ...docs].join("\n"));
  if (other.length > 0) sections.push(["### Other", ...other].join("\n"));
  return sections.length === 0 ? "No changes since the last release." : sections.join("\n\n");
}

// Puts the newest entry first, under the "# Changelog" heading.
export function withEntry(changelog: string, tag: string, date: string, notes: string): string {
  const heading = "# Changelog\n\n";
  const rest = changelog.startsWith(heading) ? changelog.slice(heading.length) : changelog;
  return `${heading}## ${tag} · ${date}\n\n${notes}\n${rest === "" ? "" : `\n${rest}`}`;
}

// Changes only the version line, so the rest of package.json keeps its layout.
export function withVersion(packageJson: string, version: string): string {
  const next = packageJson.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === packageJson) throw new Error("No version line found in package.json.");
  return next;
}

async function run(cmd: string[], cwd: string = ROOT, show: boolean = false): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: show ? "inherit" : "pipe", stderr: show ? "inherit" : "pipe" });
  const [out, err] = show ? ["", ""] : await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed${err.trim() === "" ? "" : `: ${err.trim()}`}`);
  return out.trim();
}

function step(text: string): void {
  console.log(`\n· ${text}`);
}

async function main(args: string[]): Promise<void> {
  const bump = args.find(function (a): a is Bump { return a === "patch" || a === "minor" || a === "major"; });
  const dryRun = args.includes("--dry-run");
  if (bump === undefined) throw new Error("usage: bun run release <patch|minor|major> [--dry-run]");

  step("Checking that this is origin/main with nothing on top");
  await run(["git", "fetch", "--quiet", "--tags", "origin"]);
  if ((await run(["git", "rev-parse", "HEAD"])) !== (await run(["git", "rev-parse", "origin/main"]))) {
    throw new Error("HEAD is not origin/main. Release from main as it is on GitHub (git switch main && git pull).");
  }
  if ((await run(["git", "status", "--porcelain", "--untracked-files=no"])) !== "") {
    throw new Error("There are uncommitted changes. Commit them to main first.");
  }

  step("Running tests, type checks and lint");
  await run(["bun", "test"], ROOT, true);
  await run(["bun", "run", "typecheck"], ROOT, true);
  await run(["bun", "run", "lint"], ROOT, true);
  step("Checking that convex/_generated is current");
  await run(["npx", "convex", "codegen"], CONVEX_DIR);
  if ((await run(["git", "status", "--porcelain", "--", "packages/convex/convex/_generated"])) !== "") {
    throw new Error("convex/_generated changed after codegen. Commit it to main, then release.");
  }

  const pkgFile = path.join(ROOT, "package.json");
  const pkgText = await Bun.file(pkgFile).text();
  const raw: unknown = JSON.parse(pkgText);
  const from = typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string" ? raw.version : "";
  const to = bumpVersion(from, bump);
  const tag = `v${to}`;
  if ((await run(["git", "tag", "--list", tag])) !== "") throw new Error(`Tag ${tag} already exists.`);
  const tags = (await run(["git", "tag", "--list", "v*", "--sort=-v:refname"])).split("\n").filter(function (t) {
    return /^v\d+\.\d+\.\d+$/.test(t);
  });
  const last = tags[0];
  const subjects = (await run(["git", "log", last === undefined ? "HEAD" : `${last}..HEAD`, "--no-merges", "--format=%s"]))
    .split("\n")
    .filter(function (s) { return s !== ""; });
  const notes = releaseNotes(subjects);
  console.log(`\n${last ?? "(first release)"} → ${tag}\n\n${notes}`);
  if (dryRun) {
    console.log("\nDry run: nothing deployed, committed, tagged or published.");
    return;
  }

  // Backend first: an install of this tag must find its functions deployed. Backend changes stay compatible with the
  // previous release, because installs take up to 6 hours to update.
  step("Deploying the backend to production");
  await run(["npx", "convex", "deploy", "-y"], CONVEX_DIR, true);

  step(`Committing and tagging ${tag}`);
  const date = new Date().toISOString().slice(0, 10);
  const changelogFile = path.join(ROOT, "CHANGELOG.md");
  const changelog = (await Bun.file(changelogFile).exists()) ? await Bun.file(changelogFile).text() : "";
  await Bun.write(pkgFile, withVersion(pkgText, to));
  await Bun.write(changelogFile, withEntry(changelog, tag, date, notes));
  await run(["git", "add", "package.json", "CHANGELOG.md"]);
  // RELEASE_TRAILERS adds lines such as Co-Authored-By to the release commit, for whoever (or whatever) cuts it.
  const trailers = (process.env.RELEASE_TRAILERS ?? "").trim();
  await run(["git", "commit", "--quiet", "-m", trailers === "" ? `chore(release): ${tag}` : `chore(release): ${tag}\n\n${trailers}`]);
  await run(["git", "tag", "--annotate", tag, "--message", `soopdoop ${tag}\n\n${notes}`]);
  await run(["git", "push", "--quiet", "origin", "HEAD:main"]);
  await run(["git", "push", "--quiet", "origin", tag]);

  step("Publishing the GitHub release");
  const body = `${notes}\n\n**Install:** \`${INSTALL_LINE}\`\n\n**Update:** installs update themselves within 6 hours, or run \`soopdoop update\`.\n`;
  const notesFile = path.join(tmpdir(), `soopdoop-release-${tag}.md`);
  await Bun.write(notesFile, body);
  const url = await run(["gh", "release", "create", tag, "--repo", REPO, "--verify-tag", "--title", `soopdoop ${tag}`, "--notes-file", notesFile]);
  console.log(`\nReleased ${tag}: ${url}\nInstalls pick it up within 6 hours; \`soopdoop update\` installs it now.`);
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (e) {
    console.error(`\nrelease: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
