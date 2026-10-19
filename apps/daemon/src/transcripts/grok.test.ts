// ABOUTME: Tests the Grok session reader with a made-up chat_history.jsonl and summary.json in the exact shapes Grok 1.0.46
// ABOUTME: writes (system, user with prompt_index or synthetic_reason, reasoning, assistant with tool_calls, tool_result).
import { describe, expect, test } from "bun:test";
import { routingSummary } from "./index";
import { grokFolderName, grokSummary, parseGrok } from "./grok";

const CWD = "/Users/ada/projects/vibes";

function row(r: Record<string, unknown>): string {
  return JSON.stringify(r);
}

function call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, name, arguments: JSON.stringify(args) };
}

const HISTORY = [
  row({ type: "system", content: "You are Grok Build." }),
  row({ type: "user", content: [{ type: "text", text: "<project_instructions>Use bun.</project_instructions>" }] }),
  row({ type: "user", content: [{ type: "text", text: "<system-reminder>today is Saturday</system-reminder>" }], synthetic_reason: "system_reminder" }),
  row({ type: "user", content: [{ type: "text", text: "add coupon codes to checkout" }], prompt_index: 0 }),
  row({ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking about coupons" }], encrypted_content: "gAAAA", status: "completed" }),
  row({
    type: "assistant", content: "Looking at the checkout.", model_id: "grok-4.7-build", reasoning_effort: "high",
    tool_calls: [call("call_1", "read_file", { target_file: `${CWD}/src/checkout.ts`, limit: 80 }), call("call_2", "list_dir", { target_directory: CWD })],
  }),
  row({ type: "tool_result", tool_call_id: "call_1", content: "export function total() {}" }),
  row({ type: "tool_result", tool_call_id: "call_2", content: "src/\npackage.json" }),
  row({
    type: "assistant", content: "", model_id: "grok-4.7-build",
    tool_calls: [call("call_3", "search_replace", { file_path: `${CWD}/src/coupon.ts`, old_string: "a", new_string: "b" }), call("call_4", "run_terminal_command", { command: "gh pr create --fill", description: "Open the PR" })],
  }),
  row({ type: "tool_result", tool_call_id: "call_3", content: "ok" }),
  row({ type: "tool_result", tool_call_id: "call_4", content: "exit: 0\nhttps://github.com/example-org/vibes/pull/77\n" }),
  row({ type: "assistant", content: "Coupons are in src/coupon.ts; the PR is open.", model_id: "grok-4.7-build" }),
  row({ type: "user", content: [{ type: "text", text: "merge it" }], prompt_index: 1 }),
  row({ type: "assistant", content: "", model_id: "grok-4.7-build", tool_calls: [call("call_5", "run_terminal_command", { command: "gh pr merge 77 --squash", description: "Merge" })] }),
  row({ type: "tool_result", tool_call_id: "call_5", content: "exit: 1\nX Pull request example-org/vibes#77 is not mergeable" }),
].join("\n");

describe("Grok sessions", function () {
  test("reads the hacker's numbered prompts, the agent's replies, its model, the files its tools touched and its PR", function () {
    const parsed = parseGrok(HISTORY, grokSummary({ info: { id: "g1", cwd: CWD }, head_branch: "feat/coupons", current_model_id: "grok-4.7", generated_title: "Coupon codes" }));
    expect(parsed).toMatchObject({
      cwd: CWD, branch: "feat/coupons", model: "grok-4.7-build",
      firstPrompt: "add coupon codes to checkout", lastPrompt: "merge it",
      files: [`${CWD}/src/checkout.ts`, `${CWD}/src/coupon.ts`],
      prLinks: ["https://github.com/example-org/vibes/pull/77"],
      // The merge failed: exit 1.
      merged: false,
    });
    const all = JSON.stringify(parsed);
    for (const hidden of ["You are Grok", "Use bun", "Saturday", "thinking about coupons", "gAAAA", "export function total", "package.json", "not mergeable"]) {
      expect(all).not.toContain(hidden);
    }
    expect(routingSummary(parsed, "/Users/ada")).toBe('vibes@feat/coupons · "merge it" · files: src/coupon.ts, src/checkout.ts');
  });

  test("a merge that worked is seen", function () {
    const merged = parseGrok([HISTORY, row({ type: "tool_result", tool_call_id: "call_5", content: "exit: 0\n✓ Squashed and merged pull request example-org/vibes#77" })].join("\n"));
    expect(merged.merged).toBe(true);
  });

  test("summary.json says where the session runs, its branch and its model", function () {
    expect(grokSummary({ info: { id: "g1", cwd: CWD }, head_branch: "HEAD", current_model_id: "grok-4.7" })).toMatchObject({ cwd: CWD, model: "grok-4.7" });
    expect(grokSummary({ info: { id: "g1", cwd: CWD }, head_branch: "HEAD" }).branch).toBeUndefined();
    expect(grokSummary(null)).toMatchObject({ turns: [], files: [] });
  });

  test("names a session's group folder the way Grok does: the folder, percent-encoded", function () {
    // In the form Grok 1.0.46 uses on disk.
    expect(grokFolderName("/Users/ada/.superset/worktrees/shop/quiet-otter-1a2b3c4d")).toBe("%2FUsers%2Fada%2F.superset%2Fworktrees%2Fshop%2Fquiet-otter-1a2b3c4d");
    expect(grokFolderName("/Users/ada/my app (2)!")).toBe("%2FUsers%2Fada%2Fmy%20app%20%282%29%21");
  });
});
