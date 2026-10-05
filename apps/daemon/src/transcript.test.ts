import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTranscript, readTail, routingSummary, shortPath } from "./transcript";

// Lines in the shape Claude Code writes them.
function row(type: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, cwd: "/Users/me/vibes", gitBranch: "feat/coupons", message: { role: type, content }, ...extra });
}

const TRANSCRIPT = [
  JSON.stringify({ type: "mode", mode: "default" }),
  row("user", "fix the coupon rounding in checkout"),
  row("user", [{ type: "text", text: "<system-reminder>harness note</system-reminder>" }]),
  row("assistant", [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Looking at the checkout code." },
    { type: "tool_use", name: "Read", input: { file_path: "/Users/me/vibes/src/checkout.ts" } },
  ]),
  row("user", [{ type: "tool_result", tool_use_id: "x", content: "export function total() { /* 400 lines */ }" }]),
  row("assistant", [
    { type: "tool_use", name: "Edit", input: { file_path: "/Users/me/vibes/src/coupon.ts", old_string: "a", new_string: "b" } },
    { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    { type: "text", text: "Coupons now round half up in\nsrc/coupon.ts." },
  ]),
  row("assistant", [{ type: "text", text: "side chain" }], { isSidechain: true }),
  row("user", "now ship it", { isMeta: true }),
].join("\n");

const dirs: string[] = [];
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("transcripts", function () {
  test("keeps the hacker's words, the agent's text and the files it touched; drops thinking and tool output", function () {
    const parsed = parseTranscript(TRANSCRIPT);
    expect(parsed.turns).toEqual([
      { role: "user", text: "fix the coupon rounding in checkout" },
      { role: "assistant", text: "Looking at the checkout code." },
      { role: "assistant", text: "[Read /Users/me/vibes/src/checkout.ts]" },
      { role: "assistant", text: "[Edit /Users/me/vibes/src/coupon.ts]" },
      { role: "assistant", text: "Coupons now round half up in src/coupon.ts." },
    ]);
    expect(parsed.files).toEqual(["/Users/me/vibes/src/checkout.ts", "/Users/me/vibes/src/coupon.ts"]);
    expect(parsed).toMatchObject({ lastPrompt: "fix the coupon rounding in checkout", cwd: "/Users/me/vibes", branch: "feat/coupons" });
    const all = JSON.stringify(parsed);
    for (const hidden of ["private reasoning", "400 lines", "harness note", "side chain", "now ship it", "bun test"]) {
      expect(all).not.toContain(hidden);
    }
  });

  test("the routing summary says where, what was asked, and the recent files", function () {
    expect(routingSummary(parseTranscript(TRANSCRIPT))).toBe(
      'vibes@feat/coupons · "fix the coupon rounding in checkout" · files: src/coupon.ts, src/checkout.ts',
    );
    expect(routingSummary(parseTranscript(""))).toBe("");
    const long = parseTranscript(row("user", "x".repeat(900)));
    expect(routingSummary(long).length).toBeLessThanOrEqual(600);
  });

  test("files outside the agent's folder lose their home folder and user name", function () {
    expect(shortPath("/Users/me/vibes", "/Users/me/vibes/src/a.ts", "/Users/me")).toBe("src/a.ts");
    expect(shortPath("/Users/me/vibes", "/Users/me/projects/soopdoop/apps/daemon/src/cli.ts", "/Users/me")).toBe("…/daemon/src/cli.ts");
    expect(shortPath("/Users/me/vibes", "/Users/me/notes.md", "/Users/me")).toBe("notes.md");
    expect(shortPath("/Users/me/vibes", "/private/tmp/a/b/c/d.txt", "/Users/me")).toBe("…/b/c/d.txt");
    expect(shortPath(undefined, "src/relative.ts", "/Users/me")).toBe("src/relative.ts");
    const elsewhere = parseTranscript(row("assistant", [
      { type: "tool_use", name: "Edit", input: { file_path: "/Users/me/projects/other/apps/web/page.tsx", old_string: "a", new_string: "b" } },
    ]));
    const summary = routingSummary(elsewhere, "/Users/me");
    expect(summary).toContain("files: …/apps/web/page.tsx");
    expect(summary).not.toContain("/Users/");
  });

  test("a tail read cuts the first line, which is skipped", async function () {
    const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-transcript-"));
    dirs.push(dir);
    const file = path.join(dir, "t.jsonl");
    await writeFile(file, TRANSCRIPT + "\n");
    // Everything but the first 20 bytes: the first line is cut in half.
    const tail = await readTail(file, TRANSCRIPT.length + 1 - 20);
    expect(tail.startsWith('{"type"')).toBe(false);
    expect(parseTranscript(tail).turns.at(-1)?.text).toBe("Coupons now round half up in src/coupon.ts.");
    expect(await readTail(path.join(dir, "missing.jsonl"), 300)).toBe("");
  });
});
