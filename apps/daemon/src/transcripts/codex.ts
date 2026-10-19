// ABOUTME: Reads Codex rollouts (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl): the folder and git branch from the
// ABOUTME: session_meta line, the hacker's prompts, the agent's replies, its model, the files it read or patched, its PRs and merges.
import path from "node:path";
import { isRecord } from "../state";
import { addEdit, addFile, addTurn, emptyParsed, noteCommand, oneLine, type Parsed } from "./parsed";

// Shell tools in older rollouts, whose calls and outputs are separate lines joined by call id.
const SHELL_TOOLS = new Set(["shell", "container.exec", "local_shell", "exec_command", "shell_command"]);

function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

// The script a command ran: Codex runs `["/bin/zsh", "-lc", "<script>"]`; anything else is joined.
export function commandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter(function (p): p is string { return typeof p === "string"; });
  const script = parts[2];
  if (parts.length === 3 && (parts[1] === "-lc" || parts[1] === "-c") && script !== undefined) return script;
  return parts.join(" ");
}

// The files a patch touches: its "*** Add File:", "*** Update File:", "*** Delete File:" and "*** Move to:" lines.
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const file = m[1]?.trim();
    if (file !== undefined && file !== "") files.push(file);
  }
  return files;
}

// A command's folder, which newer rollouts write as a file:// URL.
function folderOf(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  if (!cwd.startsWith("file://")) return cwd;
  try {
    return decodeURIComponent(new URL(cwd).pathname);
  } catch {
    return undefined;
  }
}

function resolveIn(cwd: string | undefined, file: string): string {
  return path.isAbsolute(file) || cwd === undefined ? file : path.join(cwd, file);
}

function userText(parsed: Parsed, p: Record<string, unknown>): void {
  const content = Array.isArray(p.content) ? p.content : [];
  const meta = isRecord(p.internal_chat_message_metadata_passthrough) ? p.internal_chat_message_metadata_passthrough : {};
  // Newer rollouts label each piece: the hacker's words are "user.text"; AGENTS.md and the environment are labelled too.
  const kinds = Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : null;
  content.forEach(function (item, i) {
    if (!isRecord(item) || typeof item.text !== "string") return;
    if (kinds !== null && kinds[i] !== "user.text") return;
    // Older rollouts did not label them: their injected pieces start with a tag or the AGENTS.md heading.
    const clean = oneLine(item.text);
    if (kinds === null && (clean.startsWith("<") || clean.startsWith("# AGENTS.md"))) return;
    addTurn(parsed, "user", item.text);
  });
}

function assistantText(parsed: Parsed, p: Record<string, unknown>): void {
  const content = Array.isArray(p.content) ? p.content : [];
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string" && (item.type === "output_text" || item.type === "text")) addTurn(parsed, "assistant", item.text);
  }
}

function patched(parsed: Parsed, patch: string): void {
  for (const file of patchFiles(patch)) {
    addEdit(parsed, file);
    addTurn(parsed, "assistant", `[Patch ${file}]`);
  }
}

// An older rollout's tool output: plain text, or JSON with the output and the exit code.
function callOutput(raw: unknown): { text: string; ok: boolean | undefined } {
  if (typeof raw !== "string") return { text: "", ok: undefined };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const meta = isRecord(parsed.metadata) ? parsed.metadata : {};
      return { text: str(parsed.output) ?? "", ok: typeof meta.exit_code === "number" ? meta.exit_code === 0 : undefined };
    }
  } catch {
    // Plain text.
  }
  return { text: raw, ok: undefined };
}

function responseItem(parsed: Parsed, p: Record<string, unknown>, calls: Map<string, string>): void {
  switch (p.type) {
    case "message":
      if (p.role === "user") userText(parsed, p);
      if (p.role === "assistant") assistantText(parsed, p);
      return;
    case "function_call": {
      const name = str(p.name) ?? "";
      let args: unknown = {};
      try {
        args = JSON.parse(str(p.arguments) ?? "{}");
      } catch {
        return;
      }
      if (!isRecord(args)) return;
      if (name === "apply_patch") patched(parsed, str(args.input) ?? str(args.patch) ?? "");
      const callId = str(p.call_id);
      if (SHELL_TOOLS.has(name) && callId !== undefined) calls.set(callId, commandText(args.command ?? args.cmd));
      return;
    }
    case "function_call_output": {
      const command = calls.get(str(p.call_id) ?? "");
      if (command === undefined) return;
      const out = callOutput(p.output);
      noteCommand(parsed, command, out.text, out.ok);
      return;
    }
    case "custom_tool_call":
      // Code mode's `exec` runs commands through tools; they come back as CommandExecution events.
      if (p.name === "apply_patch") patched(parsed, str(p.input) ?? "");
      return;
    default:
      return;
  }
}

function changedFiles(changes: unknown): string[] {
  // The rollout keys changes by path; `codex exec --json` lists { path }.
  if (Array.isArray(changes)) {
    return changes.flatMap(function (c) { return isRecord(c) && typeof c.path === "string" ? [c.path] : []; });
  }
  return isRecord(changes) ? Object.keys(changes) : [];
}

function eventMsg(parsed: Parsed, p: Record<string, unknown>): void {
  if (p.type === "item_completed" && isRecord(p.item)) {
    const item = p.item;
    if (item.type === "CommandExecution") {
      const command = commandText(item.command);
      const output = str(item.aggregated_output) ?? str(item.stdout) ?? "";
      noteCommand(parsed, command, output, typeof item.exit_code === "number" ? item.exit_code === 0 : undefined);
      const cwd = folderOf(item.cwd) ?? parsed.cwd;
      for (const step of Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []) {
        if (isRecord(step) && step.type === "read" && typeof step.path === "string") {
          const file = resolveIn(cwd, step.path);
          addFile(parsed, file);
          addTurn(parsed, "assistant", `[Read ${file}]`);
        }
      }
    }
    if (item.type === "FileChange") {
      for (const file of changedFiles(item.changes)) {
        addEdit(parsed, file);
        addTurn(parsed, "assistant", `[Patch ${file}]`);
      }
    }
    return;
  }
  // Older rollouts: one event per finished command or patch.
  if (p.type === "exec_command_end") {
    noteCommand(parsed, commandText(p.command), str(p.aggregated_output) ?? str(p.stdout) ?? "", typeof p.exit_code === "number" ? p.exit_code === 0 : undefined);
  }
  if (p.type === "patch_apply_end" && p.success !== false) for (const file of changedFiles(p.changes)) addEdit(parsed, file);
}

function sessionMeta(parsed: Parsed, p: Record<string, unknown>): void {
  if (typeof p.cwd === "string") parsed.cwd = p.cwd;
  const git = isRecord(p.git) ? p.git : {};
  if (typeof git.branch === "string" && git.branch !== "" && git.branch !== "HEAD") parsed.branch = git.branch;
  const instructions = isRecord(p.base_instructions) ? p.base_instructions : {};
  const provenance = isRecord(instructions.provenance) ? instructions.provenance : {};
  if (typeof provenance.model === "string") parsed.model ??= provenance.model;
}

// Turns, files and where the agent works. Reasoning, developer instructions, tool output and cut lines are skipped. `into`
// carries what is already known (the session_meta of a rollout whose tail no longer has it), and is filled in.
export function parseCodex(text: string, into: Parsed = emptyParsed()): Parsed {
  const parsed = into;
  const calls = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    // Rollouts since 2026 wrap each line as { timestamp, type, payload }; older ones wrote the item itself.
    const p = isRecord(row.payload) ? row.payload : null;
    if (p === null) {
      responseItem(parsed, row, calls);
      continue;
    }
    if (row.type === "session_meta") sessionMeta(parsed, p);
    if (row.type === "turn_context") {
      if (typeof p.cwd === "string") parsed.cwd = p.cwd;
      if (typeof p.model === "string") parsed.model = p.model;
    }
    if (row.type === "response_item") responseItem(parsed, p, calls);
    if (row.type === "event_msg") eventMsg(parsed, p);
  }
  return parsed;
}
