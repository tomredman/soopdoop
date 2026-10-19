// ABOUTME: The one shape every harness's transcript is read into (turns, files, prompts, where, model, PR links, merges), and
// ABOUTME: the helpers the three readers share: adding turns and files, and spotting PRs and merges in the shell commands an agent ran.

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface Parsed {
  turns: Turn[];
  // Files the agent read or changed, oldest first.
  files: string[];
  // The files it changed (each is in `files` too), oldest first. The ledger's areas come from these. Missing until one is.
  edited?: string[];
  // The hacker's first and last prompts.
  firstPrompt?: string;
  lastPrompt?: string;
  cwd?: string;
  branch?: string;
  // The model of the agent's last reply, which an answering copy of the session uses too.
  model?: string;
  // Pull requests the agent opened or merged, oldest first: from `gh pr create` and `gh pr merge`, and from links in the
  // agent's own replies.
  prLinks: string[];
  // True once the agent merged into main: `gh pr merge`, `git merge` on main, or a push of another branch to main.
  merged: boolean;
}

export const MAX_TURN_CHARS = 4_000;

export function emptyParsed(): Parsed {
  return { turns: [], files: [], prLinks: [], merged: false };
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Adds one turn, cut when it is long. A user turn is a prompt: it becomes the last prompt, and the first one if it is.
export function addTurn(parsed: Parsed, role: "user" | "assistant", text: string): void {
  const clean = oneLine(text);
  if (clean === "") return;
  parsed.turns.push({ role, text: clean.length > MAX_TURN_CHARS ? `${clean.slice(0, MAX_TURN_CHARS)}…` : clean });
  if (role === "user") {
    parsed.firstPrompt ??= clean;
    parsed.lastPrompt = clean;
  }
  if (role === "assistant") for (const url of prUrls(text)) addPr(parsed, url);
}

export function addFile(parsed: Parsed, file: string): void {
  if (file !== "") parsed.files.push(file);
}

// A file the agent changed (wrote, edited or patched). It counts as touched too.
export function addEdit(parsed: Parsed, file: string): void {
  if (file === "") return;
  parsed.files.push(file);
  if (parsed.edited === undefined) parsed.edited = [];
  parsed.edited.push(file);
}

const PR_URL = /https?:\/\/[A-Za-z0-9.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// Pull request links in a piece of text, in order.
export function prUrls(text: string): string[] {
  return text.match(PR_URL) ?? [];
}

function addPr(parsed: Parsed, url: string): void {
  if (!parsed.prLinks.includes(url)) parsed.prLinks.push(url);
}

const ON_MAIN = /^(?:main|master)$/;
// `git merge`, but not `git merge --abort`.
const GIT_MERGE = /\bgit\s+merge\b(?!\s+--abort)/;
const SWITCH_THEN_MERGE = /\bgit\s+(?:checkout|switch)\s+(?:main|master)\b[\s\S]*\bgit\s+merge\b(?!\s+--abort)/;
// `git push origin feat/x:main` or `HEAD:main`, but not `main:main` and not `:main` (which deletes it).
const PUSH_TO_MAIN = /\bgit\s+push\b[^\n;&|]*\s\+?(?!(?:main|master):)[^\s:]+:(?:refs\/heads\/)?(?:main|master)\b/;

// Whether a shell command merges into main: `git merge` while on main, `git checkout main` (or switch) followed by
// `git merge` in the same command, or a push of another branch to main. `branch` is the branch the session was on.
export function mergesIntoMain(command: string, branch: string | undefined): boolean {
  if (branch !== undefined && ON_MAIN.test(branch) && GIT_MERGE.test(command)) return true;
  return SWITCH_THEN_MERGE.test(command) || PUSH_TO_MAIN.test(command);
}

// Output that says a command failed, for transcripts that do not record exit codes.
function looksFailed(output: string): boolean {
  return /\b(?:error|failed|fatal|not mergeable|could not)\b/i.test(output);
}

// One shell command the agent ran and what it printed. `ok` is whether it succeeded, or undefined when the transcript does
// not say. A PR that `gh pr create` opened, or that `gh pr merge` merged, is kept; so is a merge into main.
export function noteCommand(parsed: Parsed, command: string, output: string, ok: boolean | undefined): void {
  const worked = ok ?? !looksFailed(output);
  if (!worked) return;
  if (/\bgh\s+pr\s+create\b/.test(command)) for (const url of prUrls(output)) addPr(parsed, url);
  if (/\bgh\s+pr\s+merge\b/.test(command)) {
    for (const url of [...prUrls(command), ...prUrls(output)]) addPr(parsed, url);
    parsed.merged = true;
  }
  if (mergesIntoMain(command, parsed.branch)) parsed.merged = true;
}
