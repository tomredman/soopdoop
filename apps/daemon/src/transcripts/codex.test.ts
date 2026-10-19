// ABOUTME: Tests the Codex rollout reader with made-up sessions in the exact line shapes Codex 0.160.0 writes (session_meta,
// ABOUTME: turn_context, response_item, event_msg), and the older shapes of 2025 rollouts. No real session content.
import { describe, expect, test } from "bun:test";
import { routingSummary } from "./index";
import { commandText, parseCodex, patchFiles } from "./codex";

const CWD = "/Users/ada/projects/vibes";

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-10-18T13:00:00.000Z", ordinal: 0, type, payload });
}

function message(role: string, texts: string[], kinds?: string[]): string {
  const meta = kinds === undefined ? {} : { internal_chat_message_metadata_passthrough: { turn_id: "t1", content_item_kinds: kinds } };
  return line("response_item", { type: "message", id: "msg_1", role, content: texts.map(function (text) { return { type: role === "assistant" ? "output_text" : "input_text", text }; }), ...meta });
}

function command(cmd: string, output: string, exitCode: number, parsed: Record<string, unknown>[] = [{ type: "unknown", cmd }]): string {
  return line("event_msg", {
    type: "item_completed", thread_id: "th", turn_id: "t1",
    item: { type: "CommandExecution", id: "exec-1", command: ["/bin/zsh", "-lc", cmd], cwd: `file://${CWD}`, parsed_cmd: parsed, source: "unified_exec_startup", status: exitCode === 0 ? "completed" : "failed", aggregated_output: output, exit_code: exitCode },
  });
}

// One session, two turns, in the order Codex writes them.
const ROLLOUT = [
  line("session_meta", { id: "01a00000-0000-7000-8000-000000000c0d", cwd: CWD, originator: "codex-tui", cli_version: "0.160.0", source: "cli", model_provider: "openai", base_instructions: { text: "You are Codex.", provenance: { type: "model", model: "gpt-6.1-sol" } }, git: { commit_hash: "abc", branch: "feat/coupons" } }),
  line("event_msg", { type: "task_started", turn_id: "t1" }),
  message("developer", ["<permissions instructions>never ask</permissions instructions>"], ["permissions.instructions"]),
  message("user", ["# AGENTS.md instructions for /Users/ada/projects/vibes\n\nUse bun.", "<environment_context>zsh</environment_context>"], ["agents_md.instructions", "environments.environment_context"]),
  line("turn_context", { turn_id: "t1", cwd: CWD, model: "gpt-6.1-sol", effort: "medium" }),
  message("user", ["add coupon codes to checkout"], ["user.text"]),
  line("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "add coupon codes to checkout" }] } }),
  message("assistant", ["I will look at the checkout first."]),
  line("response_item", { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(await tools.exec_command({cmd:\"cat src/checkout.ts\"}));" }),
  command("cat src/checkout.ts", "export function total() {}", 0, [{ type: "read", cmd: "cat src/checkout.ts", name: "checkout.ts", path: "src/checkout.ts" }]),
  line("response_item", { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed" }] }),
  line("event_msg", { type: "item_completed", item: { type: "FileChange", id: "exec-2", changes: { [`${CWD}/src/coupon.ts`]: { type: "add", unified_diff: "+export const x = 1;", move_path: null } }, status: "completed" } }),
  line("response_item", { type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
  command("gh pr create --fill", "https://github.com/example-org/vibes/pull/412\n", 0),
  command("gh pr merge 999 --squash", "X Pull request example-org/vibes#999 is not mergeable", 1),
  line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 5 } } }),
  message("assistant", ["Coupons are in src/coupon.ts. PR: [#412](https://github.com/example-org/vibes/pull/412)"]),
  line("event_msg", { type: "task_complete", last_agent_message: "Coupons are in src/coupon.ts." }),
  line("turn_context", { turn_id: "t2", cwd: CWD, model: "gpt-6-sol" }),
  message("user", ["now round them half up"], ["user.text"]),
].join("\n");

describe("Codex rollouts", function () {
  test("reads the folder and branch, the hacker's own words, the agent's replies, files and the model", function () {
    const parsed = parseCodex(ROLLOUT);
    expect(parsed).toMatchObject({
      cwd: CWD, branch: "feat/coupons", model: "gpt-6-sol",
      firstPrompt: "add coupon codes to checkout", lastPrompt: "now round them half up",
      files: [`${CWD}/src/checkout.ts`, `${CWD}/src/coupon.ts`],
      prLinks: ["https://github.com/example-org/vibes/pull/412"], merged: false,
    });
    expect(parsed.turns).toEqual([
      { role: "user", text: "add coupon codes to checkout" },
      { role: "assistant", text: "I will look at the checkout first." },
      { role: "assistant", text: `[Read ${CWD}/src/checkout.ts]` },
      { role: "assistant", text: `[Patch ${CWD}/src/coupon.ts]` },
      { role: "assistant", text: "Coupons are in src/coupon.ts. PR: [#412](https://github.com/example-org/vibes/pull/412)" },
      { role: "user", text: "now round them half up" },
    ]);
    const all = JSON.stringify(parsed);
    for (const hidden of ["never ask", "Use bun", "zsh", "export function total", "gAAAA", "not mergeable"]) expect(all).not.toContain(hidden);
    expect(routingSummary(parsed, "/Users/ada")).toBe('vibes@feat/coupons · "now round them half up" · files: src/coupon.ts, src/checkout.ts');
  });

  test("a merge that worked is seen", function () {
    const parsed = parseCodex([ROLLOUT, command("gh pr merge 412 --squash", "✓ Squashed and merged pull request example-org/vibes#412", 0)].join("\n"));
    expect(parsed.merged).toBe(true);
  });

  test("reads the older 2025 rollouts too: items without a wrapper, shell calls joined to their output by call id", function () {
    const old = [
      JSON.stringify({ id: "5f0e0000-0000-4000-8000-000000000001", timestamp: "2025-09-04T15:59:50.000Z", instructions: null }),
      JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/Users/ada/projects/vibes</cwd>\n</environment_context>" }] }),
      JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "ship the coupon fix" }] }),
      JSON.stringify({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "git checkout main && git merge feat/coupons"] }), call_id: "call_1" }),
      JSON.stringify({ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ output: "Fast-forward", metadata: { exit_code: 0 } }) }),
      JSON.stringify({ type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: src/coupon.ts\n@@\n-a\n+b\n*** End Patch" }), call_id: "call_2" }),
      JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Merged." }] }),
    ].join("\n");
    const parsed = parseCodex(old);
    expect(parsed).toMatchObject({ firstPrompt: "ship the coupon fix", merged: true, files: ["src/coupon.ts"] });
    expect(parsed.turns.at(-1)).toEqual({ role: "assistant", text: "Merged." });
  });

  test("helpers: a command's script, and the files a patch touches", function () {
    expect(commandText(["/bin/zsh", "-lc", "rg coupon src"])).toBe("rg coupon src");
    expect(commandText(["git", "status"])).toBe("git status");
    expect(commandText("ls")).toBe("ls");
    expect(patchFiles("*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move to: c.ts\n*** Delete File: d.ts\n*** End Patch")).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  test("a tail read cuts the first line, which is skipped", function () {
    expect(parseCodex(ROLLOUT.slice(40)).lastPrompt).toBe("now round them half up");
  });
});
