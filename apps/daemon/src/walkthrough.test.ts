import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asked } from "./ask";
import { fundPath } from "./fund";
import type { AgentRecord, Subset } from "./state";
import { cleanPage, makeWalkthrough, MAX_PAGE, parseWalkthroughRequest, walkthroughPath, walkthroughPrompt, type WalkthroughDeps } from "./walkthrough";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-walk-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const PAGE = "<!doctype html><html><head><title>Walkthrough</title><style>body{background:#111;color:#eee}</style></head><body><h1>What changed</h1></body></html>";

describe("the page", function () {
  test("keeps only the HTML, and adds a policy that loads nothing from anywhere", function () {
    const got = cleanPage(`Here it is:\n\`\`\`html\n${PAGE}\n\`\`\`\nHope it helps.`);
    expect(got).toEqual({
      html: "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\"><title>Walkthrough</title><style>body{background:#111;color:#eee}</style></head><body><h1>What changed</h1></body></html>",
    });
    const noHead = cleanPage("<html><body>x</body></html>");
    expect("html" in noHead && noHead.html.startsWith("<html><head><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
  });

  test("takes secret-looking strings out, and refuses what is not a page or is too big", function () {
    const got = cleanPage(PAGE.replace("What changed", "key sk-abcdefghijklmnopqrstuvwxyz123456"));
    expect("html" in got && got.html.includes("[secret]") && !got.html.includes("sk-abc")).toBe(true);
    expect(cleanPage("I could not write it.")).toEqual({ problem: "The agent did not write an HTML page." });
    expect(cleanPage(`<!doctype html><html><body>${"x".repeat(MAX_PAGE)}</body></html>`)).toEqual({ problem: "The page came out over 60 KB." });
  });

  test("asks for a dark, self-contained page under 60 KB, and only the HTML", function () {
    const prompt = walkthroughPrompt();
    expect(prompt).toContain("self-contained HTML page");
    expect(prompt).toContain("A dark page");
    expect(prompt).toContain("under 60 KB");
    expect(prompt).toContain("Output only the HTML");
  });

  test("takes only a plain ledger id and session key", function () {
    expect(parseWalkthroughRequest({ ledgerId: "jd7abc", sessionKey: "6132-abcd" })).toEqual({ ledgerId: "jd7abc", sessionKey: "6132-abcd" });
    expect(parseWalkthroughRequest({ ledgerId: "../../etc", sessionKey: "s" })).toBeNull();
    expect(parseWalkthroughRequest({ ledgerId: "a", sessionKey: "a/b" })).toBeNull();
    expect(parseWalkthroughRequest(null)).toBeNull();
  });
});

function running(over: Partial<AgentRecord> = {}): AgentRecord {
  return { agentId: "s1", harness: "claude-code", name: "vibes", status: "idle", open: true, lastTurnAt: 0, transcriptPath: "/t/s1.jsonl", ...over };
}

async function walkDeps(over: Partial<WalkthroughDeps> & { answer?: Asked } = {}): Promise<{ deps: WalkthroughDeps; forked: { agent: AgentRecord; prompt: string }[] }> {
  const forked: { agent: AgentRecord; prompt: string }[] = [];
  const home = await tempDir();
  return {
    forked,
    deps: {
      home,
      privateDirs: [],
      async fork(agent, prompt) {
        forked.push({ agent, prompt });
        return over.answer ?? { answer: PAGE, usd: 0.31, tokensRead: 120_000, model: "claude-sonnet-5-5" };
      },
      async find() { return null; },
      now: Date.now,
      ...over,
    },
  };
}

describe("making a walkthrough", function () {
  test("a copy of the session writes the page, saved by its ledger id, logged in reads.log with what it cost", async function () {
    const { deps, forked } = await walkDeps();
    const subset: Subset = new Map([["s1", running()]]);
    const made = await makeWalkthrough({ ledgerId: "jd7abc", sessionKey: "s1" }, subset, [], deps);
    expect(made).toEqual({ path: walkthroughPath("jd7abc", deps.home) });
    expect(forked).toEqual([{ agent: running(), prompt: walkthroughPrompt() }]);
    const page = await readFile(walkthroughPath("jd7abc", deps.home), "utf8");
    expect(page).toContain("Content-Security-Policy");
    expect((await stat(walkthroughPath("jd7abc", deps.home))).mode & 0o777).toBe(0o600);
    const read = JSON.parse((await readFile(path.join(deps.home, "logs", "reads.log"), "utf8")).trim());
    expect(read).toMatchObject({ kind: "walkthrough", ledgerId: "jd7abc", agentId: "s1", usd: 0.31, tokensRead: 120_000, sentChars: page.length });
  });

  test("finds a session that is not running by its transcript, and refuses a private one", async function () {
    const home = await tempDir();
    const file = path.join(home, "x1.jsonl");
    await writeFile(file, JSON.stringify({ timestamp: "2026-10-19T00:00:00Z", type: "session_meta", payload: { cwd: "/r/private-repo" } }) + "\n");
    const { deps, forked } = await walkDeps({
      home,
      privateDirs: ["/r/private-repo"],
      async find(harness) { return harness === "codex" ? file : null; },
    });
    expect(await makeWalkthrough({ ledgerId: "jd7abc", sessionKey: "x1" }, new Map(), deps.privateDirs, deps)).toEqual({ problem: "That agent is private, so its work stays off soopdoop.", status: 403 });
    expect(forked).toEqual([]);
    const open = await walkDeps({ async find(harness) { return harness === "codex" ? file : null; } });
    expect("path" in (await makeWalkthrough({ ledgerId: "jd7abc", sessionKey: "x1" }, new Map(), [], open.deps))).toBe(true);
    expect(open.forked[0]?.agent).toMatchObject({ agentId: "x1", harness: "codex", name: "private-repo", cwd: "/r/private-repo", transcriptPath: file });
  });

  test("says why there is no page: a bad request, no such session, the fund spent, or the copy's own failure", async function () {
    const { deps } = await walkDeps();
    expect(await makeWalkthrough({ ledgerId: "a" }, new Map(), [], deps)).toEqual({ problem: "Expected { ledgerId, sessionKey }.", status: 400 });
    expect(await makeWalkthrough({ ledgerId: "a", sessionKey: "nobody" }, new Map(), [], deps)).toEqual({ problem: "That session is not on this Mac.", status: 404 });
    await writeFile(fundPath(deps.home), JSON.stringify({ dailyUsd: 0 }));
    expect(await makeWalkthrough({ ledgerId: "a", sessionKey: "s1" }, new Map([["s1", running()]]), [], deps)).toEqual({ problem: "The answering fund is $0 (soopdoop fund), so no walkthrough.", status: 429 });
    const failing = await walkDeps({ answer: { refused: "That agent took too long to answer.", usd: 0.05 } });
    expect(await makeWalkthrough({ ledgerId: "a", sessionKey: "s1" }, new Map([["s1", running()]]), [], failing.deps)).toEqual({ problem: "That agent took too long to answer.", status: 502 });
    // What the copy cost is logged even when it wrote no page.
    expect(await readFile(path.join(failing.deps.home, "logs", "reads.log"), "utf8")).toContain("\"usd\":0.05");
  });
});
