// ABOUTME: Tests finding a session's transcript in each harness's folder (in temporary homes, never the real ones) and reading
// ABOUTME: it with what sits beside it: a Codex rollout's first line, a Grok session's summary.json.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexDays, findTranscript, harnessHomes, parseFor, readTranscript, type Homes } from "./index";

const dirs: string[] = [];
async function tempHomes(): Promise<Homes> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-transcripts-"));
  dirs.push(dir);
  return { claude: path.join(dir, ".claude"), codex: path.join(dir, ".codex"), grok: path.join(dir, ".grok") };
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function put(file: string, text: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

// A UUIDv7 made for 18 Oct 2026, 13:00 UTC: its first 48 bits are that time in milliseconds.
const STARTED = Date.parse("2026-10-18T13:00:00Z");
const CODEX_ID = `${STARTED.toString(16).padStart(12, "0").slice(0, 8)}-${STARTED.toString(16).padStart(12, "0").slice(8)}-7000-8000-000000000c0d`;

function localDay(ms: number): string {
  const t = new Date(ms);
  return `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, "0")}/${String(t.getDate()).padStart(2, "0")}`;
}

describe("finding transcripts", function () {
  test("where each harness keeps its sessions, from the environment or the home folder", function () {
    expect(harnessHomes({}, "/Users/ada")).toEqual({ claude: "/Users/ada/.claude", codex: "/Users/ada/.codex", grok: "/Users/ada/.grok" });
    expect(harnessHomes({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", GROK_HOME: "", }, "/Users/ada")).toEqual({ claude: "/c", codex: "/x", grok: "/Users/ada/.grok" });
  });

  test("a Codex session's day comes from its UUIDv7 id; other ids have none", function () {
    expect(codexDays(CODEX_ID)[0]).toBe(localDay(STARTED));
    expect(codexDays(CODEX_ID)).toHaveLength(3);
    expect(codexDays("5f0e0000-0000-4000-8000-000000000001")).toEqual([]);
    expect(codexDays("not-an-id")).toEqual([]);
  });

  test("Claude Code: the path the hook gave, else the project folder named after the session's folder, else any project", async function () {
    const homes = await tempHomes();
    const cwd = "/Users/ada/projects/vibes.app";
    const file = await put(path.join(homes.claude, "projects", "-Users-ada-projects-vibes-app", "s1.jsonl"), "{}\n");
    expect(await findTranscript("claude-code", "s1", cwd, undefined, homes)).toBe(file);
    expect(await findTranscript("claude-code", "s1", undefined, undefined, homes)).toBe(file);
    expect(await findTranscript("claude-code", "s1", cwd, "/missing.jsonl", homes)).toBe(file);
    const given = await put(path.join(homes.claude, "elsewhere.jsonl"), "{}\n");
    expect(await findTranscript("claude-code", "s1", cwd, given, homes)).toBe(given);
    expect(await findTranscript("claude-code", "nope", cwd, undefined, homes)).toBeNull();
  });

  test("Codex: the rollout in the session's day folder, else in any day folder", async function () {
    const homes = await tempHomes();
    const file = await put(path.join(homes.codex, "sessions", localDay(STARTED), `rollout-2026-10-18T09-00-00-${CODEX_ID}.jsonl`), "{}\n");
    expect(await findTranscript("codex", CODEX_ID, undefined, undefined, homes)).toBe(file);
    const older = await put(path.join(homes.codex, "sessions", "2025", "09", "04", "rollout-2025-09-04T11-59-50-5f0e0000-0000-4000-8000-000000000001.jsonl"), "{}\n");
    expect(await findTranscript("codex", "5f0e0000-0000-4000-8000-000000000001", undefined, undefined, homes)).toBe(older);
    expect(await findTranscript("codex", "5f0e0000-0000-4000-8000-000000000002", undefined, undefined, homes)).toBeNull();
  });

  test("Grok: the chat history under the session's percent-encoded folder, else under any folder", async function () {
    const homes = await tempHomes();
    const cwd = "/Users/ada/projects/vibes";
    const file = await put(path.join(homes.grok, "sessions", "%2FUsers%2Fada%2Fprojects%2Fvibes", "g1", "chat_history.jsonl"), "{}\n");
    expect(await findTranscript("grok", "g1", cwd, undefined, homes)).toBe(file);
    // A long folder name is a slug and a hash on disk.
    const slugged = await put(path.join(homes.grok, "sessions", "Users-ada-a-very-long-folder-1f2e3d", "g2", "chat_history.jsonl"), "{}\n");
    expect(await findTranscript("grok", "g2", "/Users/ada/a/very/long/folder", undefined, homes)).toBe(slugged);
    expect(await findTranscript("grok", "g3", cwd, undefined, homes)).toBeNull();
  });

  test("an id that is not a plain id is never looked up", async function () {
    const homes = await tempHomes();
    await put(path.join(homes.grok, "sessions", "x", "secret", "chat_history.jsonl"), "{}\n");
    expect(await findTranscript("grok", "../x/secret", undefined, undefined, homes)).toBeNull();
    expect(await findTranscript("codex", "*", undefined, undefined, homes)).toBeNull();
  });
});

describe("reading transcripts", function () {
  test("each harness's reader by name; anything else is read as Claude Code", function () {
    const claude = JSON.stringify({ type: "user", cwd: "/r/vibes", message: { role: "user", content: "hello claude" } });
    const codex = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } });
    const grok = JSON.stringify({ type: "user", content: [{ type: "text", text: "hello grok" }], prompt_index: 0 });
    expect(parseFor("claude-code", claude).lastPrompt).toBe("hello claude");
    expect(parseFor("codex", codex).lastPrompt).toBe("hello codex");
    expect(parseFor("grok", grok).lastPrompt).toBe("hello grok");
    expect(parseFor("something-else", claude).lastPrompt).toBe("hello claude");
  });

  test("a long Codex rollout's tail lacks its first line; the folder and branch still come from it", async function () {
    const homes = await tempHomes();
    const meta = JSON.stringify({ timestamp: "2026-10-18T13:00:00Z", type: "session_meta", payload: { id: CODEX_ID, cwd: "/Users/ada/projects/vibes", git: { branch: "main" } } });
    const filler = Array.from({ length: 50 }, function (_, i) {
      return JSON.stringify({ timestamp: "2026-10-18T13:00:01Z", type: "event_msg", payload: { type: "token_count", n: i, pad: "x".repeat(100) } });
    });
    const prompt = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "merge the coupon branch" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } });
    const merge = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "git merge feat/coupons"], aggregated_output: "Fast-forward", exit_code: 0 } } });
    const file = await put(path.join(homes.codex, "sessions", "2026", "10", "18", `rollout-x-${CODEX_ID}.jsonl`), [meta, ...filler, prompt, merge].join("\n") + "\n");
    const parsed = await readTranscript("codex", file, 1_000);
    // On main (from the first line), so git merge is a merge into main.
    expect(parsed).toMatchObject({ cwd: "/Users/ada/projects/vibes", branch: "main", lastPrompt: "merge the coupon branch", merged: true });
  });

  test("a Grok session's summary.json gives its folder and branch; the chat history its model", async function () {
    const homes = await tempHomes();
    const folder = path.join(homes.grok, "sessions", "%2FUsers%2Fada%2Fprojects%2Fvibes", "g1");
    await put(path.join(folder, "summary.json"), JSON.stringify({ info: { id: "g1", cwd: "/Users/ada/projects/vibes" }, head_branch: "feat/coupons", current_model_id: "grok-4.7" }));
    const file = await put(path.join(folder, "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "add coupons" }], prompt_index: 0 }),
      JSON.stringify({ type: "assistant", content: "Done.", model_id: "grok-4.7-build" }),
    ].join("\n") + "\n");
    expect(await readTranscript("grok", file)).toMatchObject({ cwd: "/Users/ada/projects/vibes", branch: "feat/coupons", model: "grok-4.7-build", lastPrompt: "add coupons" });
    // Without a summary.json there is still the conversation.
    expect(await readTranscript("grok", await put(path.join(homes.grok, "sessions", "x", "g2", "chat_history.jsonl"), JSON.stringify({ type: "user", content: [{ type: "text", text: "hi" }], prompt_index: 0 })))).toMatchObject({ lastPrompt: "hi" });
  });
});
