// ABOUTME: Walkthroughs: a copy of the session that did a piece of work writes one self-contained HTML page about what changed
// ABOUTME: and why, on this Mac, within the answering fund; the daemon saves it as ~/.soopdoop/walkthroughs/<ledgerId>.html.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../../../packages/convex/convex/lib/summaries";
import { forkAgent, type Asked } from "./ask";
import { soopdoopHome } from "./config";
import { fundLimit, fundPath, readFund, readSpends } from "./fund";
import { logRead } from "./operator";
import { isPrivate, repoRoot } from "./privacy";
import { isRecord, type AgentRecord, type Subset } from "./state";
import { findTranscript, readTranscript } from "./transcripts/index";

// The page's size limit, in bytes.
export const MAX_PAGE = 60_000;
// Writing a page takes the copy a few minutes.
const WRITE_MS = 5 * 60 * 1000;
// What the page may load: nothing from the network, no scripts; its own styles and inline images only.
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function walkthroughPrompt(): string {
  return [
    "Write a walkthrough of the work you did in this conversation, for a teammate who did not see it, as one self-contained HTML page.",
    "- Say what changed and why, in plain words and short paragraphs.",
    "- Show before and after where this conversation shows them: code, commands or output, in <pre> blocks.",
    "- List the files that changed, by their path inside the project (never the full path on this computer), and the pull request link if there is one.",
    "- A dark page: dark background, light text, one accent color. All CSS in one <style> element. No scripts, and nothing from the network (no fonts, images, scripts or stylesheets from a URL).",
    "- Keep it under 60 KB.",
    "- Never include secrets, keys, tokens or credentials, even if they appear above.",
    "You have no tools for this reply, and it does not go back into your session. Output only the HTML, starting with <!doctype html>, with nothing before or after it.",
  ].join("\n");
}

export function walkthroughPath(ledgerId: string, home: string = soopdoopHome()): string {
  return path.join(home, "walkthroughs", `${ledgerId}.html`);
}

// The page the copy wrote, made safe to keep and share: the HTML only (no Markdown fence or words around it), secret-looking
// strings taken out, and a content security policy so that it loads nothing from anywhere.
export function cleanPage(raw: string): { html: string } | { problem: string } {
  let text = raw.trim().replace(/^```(?:html)?\s*\n/i, "").replace(/\n```\s*$/, "");
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return { problem: "The agent did not write an HTML page." };
  text = text.slice(start);
  const end = text.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) text = text.slice(0, end + "</html>".length);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
  const head = /<head[^>]*>/i.exec(text);
  const html = head === null
    ? text.replace(/<html[^>]*>/i, function (tag) { return `${tag}<head>${meta}</head>`; })
    : `${text.slice(0, head.index + head[0].length)}${meta}${text.slice(head.index + head[0].length)}`;
  const page = redactSecrets(html);
  if (Buffer.byteLength(page) > MAX_PAGE) return { problem: "The page came out over 60 KB." };
  return { html: page };
}

export interface WalkthroughRequest {
  ledgerId: string;
  // The session that did the work: its session id.
  sessionKey: string;
}

export function parseWalkthroughRequest(raw: unknown): WalkthroughRequest | null {
  if (!isRecord(raw) || typeof raw.ledgerId !== "string" || typeof raw.sessionKey !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw.ledgerId) || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.sessionKey)) return null;
  return { ledgerId: raw.ledgerId, sessionKey: raw.sessionKey };
}

export type Made = { path: string } | { problem: string; status: number };

export interface WalkthroughDeps {
  home: string;
  privateDirs: string[];
  fork: (agent: AgentRecord, prompt: string) => Promise<Asked>;
  find: (harness: string, sessionId: string) => Promise<string | null>;
  now: () => number;
}

function defaultDeps(privateDirs: string[]): WalkthroughDeps {
  return {
    home: soopdoopHome(),
    privateDirs,
    fork(agent, prompt) { return forkAgent(agent, prompt, { timeoutMs: WRITE_MS, maxChars: MAX_PAGE * 2 }); },
    find(harness, sessionId) { return findTranscript(harness, sessionId); },
    now: Date.now,
  };
}

// The session, running here or not: a running agent as the daemon knows it, else the first harness with a transcript for it.
async function sessionFor(sessionKey: string, subset: Subset, deps: WalkthroughDeps): Promise<AgentRecord | null> {
  const running = subset.get(sessionKey);
  if (running !== undefined) return running;
  for (const harness of ["claude-code", "codex", "grok"]) {
    const file = await deps.find(harness, sessionKey);
    if (file === null) continue;
    const cwd = (await readTranscript(harness, file)).cwd;
    const repo = cwd === undefined ? undefined : (repoRoot(cwd) ?? undefined);
    return {
      agentId: sessionKey, harness, name: cwd === undefined ? "agent" : path.basename(cwd), status: "idle",
      open: !isPrivate(cwd, repo, deps.privateDirs), transcriptPath: file, lastTurnAt: 0, ...(cwd === undefined ? {} : { cwd }),
      ...(repo === undefined ? {} : { repo }),
    };
  }
  return null;
}

// POST /walkthrough {ledgerId, sessionKey}: writes the page and says where it is.
export async function makeWalkthrough(raw: unknown, subset: Subset, privateDirs: string[], deps: WalkthroughDeps = defaultDeps(privateDirs)): Promise<Made> {
  const req = parseWalkthroughRequest(raw);
  if (req === null) return { problem: "Expected { ledgerId, sessionKey }.", status: 400 };
  const agent = await sessionFor(req.sessionKey, subset, deps);
  if (agent === null) return { problem: "That session is not on this Mac.", status: 404 };
  if (!agent.open) return { problem: "That agent is private, so its work stays off soopdoop.", status: 403 };
  const limit = fundLimit(await readFund(fundPath(deps.home)), await readSpends(deps.home), { agentId: agent.agentId }, deps.now());
  if (limit !== null) {
    return { problem: limit.kind === "off" ? "The answering fund is $0 (soopdoop fund), so no walkthrough." : "The answering fund is spent for today (soopdoop fund).", status: 429 };
  }
  const asked = await deps.fork(agent, walkthroughPrompt());
  const page = "answer" in asked ? cleanPage(asked.answer) : { problem: asked.refused };
  await logRead({
    kind: "walkthrough", ledgerId: req.ledgerId, agentId: agent.agentId, agent: agent.name, model: asked.model,
    sentChars: "html" in page ? page.html.length : 0, tokensRead: asked.tokensRead, usd: asked.usd,
    refused: "problem" in page ? page.problem : undefined,
  }, deps.home);
  if ("problem" in page) return { problem: page.problem, status: 502 };
  const file = walkthroughPath(req.ledgerId, deps.home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, page.html, { mode: 0o600 });
  return { path: file };
}
