// ABOUTME: Tests the Claude Code transcript reader's newer fields: the first prompt, PR links from gh output and the agent's own
// ABOUTME: replies, and merges into main. Made-up sessions in the shape Claude Code writes; the older behaviour is in transcript.test.ts.
import { describe, expect, test } from "bun:test";
import { parseClaude } from "./claude";

function row(type: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, cwd: "/Users/ada/vibes", gitBranch: "feat/coupons", message: { role: type, content }, ...extra });
}

function bash(id: string, command: string): string {
  return row("assistant", [{ type: "tool_use", id, name: "Bash", input: { command } }]);
}

function output(id: string, text: string, isError = false): string {
  return row("user", [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }]);
}

describe("Claude Code transcripts", function () {
  test("keeps the first and the last prompt", function () {
    const parsed = parseClaude([
      row("user", "add coupon codes to checkout"),
      row("user", [{ type: "text", text: "<command-name>/clear</command-name>" }]),
      row("assistant", [{ type: "text", text: "Done." }]),
      row("user", "now round them half up"),
    ].join("\n"));
    expect(parsed.firstPrompt).toBe("add coupon codes to checkout");
    expect(parsed.lastPrompt).toBe("now round them half up");
  });

  test("finds the PR that gh pr create opened, and a merge; a failed command counts for nothing", function () {
    const parsed = parseClaude([
      bash("t1", "gh pr create --fill"),
      output("t1", "Creating pull request for feat/coupons into main in example-org/vibes\n\nhttps://github.com/example-org/vibes/pull/412\n"),
      bash("t2", "gh pr merge 413 --squash"),
      output("t2", "X Pull request example-org/vibes#413 is not mergeable", true),
    ].join("\n"));
    expect(parsed.prLinks).toEqual(["https://github.com/example-org/vibes/pull/412"]);
    expect(parsed.merged).toBe(false);

    const merged = parseClaude([
      bash("t3", "gh pr merge https://github.com/example-org/vibes/pull/412 --squash --delete-branch"),
      output("t3", "✓ Squashed and merged pull request example-org/vibes#412 (Coupon codes)"),
    ].join("\n"));
    expect(merged.prLinks).toEqual(["https://github.com/example-org/vibes/pull/412"]);
    expect(merged.merged).toBe(true);
  });

  test("a PR link in the agent's own reply counts; one in the hacker's prompt does not", function () {
    const parsed = parseClaude([
      row("user", "review https://github.com/example-org/vibes/pull/7 please"),
      row("assistant", [{ type: "text", text: "Opened https://github.com/example-org/vibes/pull/9 for the fix." }]),
    ].join("\n"));
    expect(parsed.prLinks).toEqual(["https://github.com/example-org/vibes/pull/9"]);
  });

  test("git merge on main is a merge into main; on a feature branch it is not", function () {
    const onMain = parseClaude([
      JSON.stringify({ type: "assistant", cwd: "/Users/ada/vibes", gitBranch: "main", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git merge feat/coupons" } }] } }),
      JSON.stringify({ type: "user", cwd: "/Users/ada/vibes", gitBranch: "main", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Fast-forward" }] } }),
    ].join("\n"));
    expect(onMain.merged).toBe(true);
    const onFeature = parseClaude([bash("t1", "git merge main"), output("t1", "Already up to date.")].join("\n"));
    expect(onFeature.merged).toBe(false);
  });
});
