// ABOUTME: Reads Claude Code transcripts (<config dir>/projects/<folder>/<id>.jsonl): the hacker's prompts, the agent's text, the
// ABOUTME: files its tools touched, its model, where it works, and the PRs and merges its Bash commands made. Pure parsing.
import { isRecord } from "../state";
import { addFile, addTurn, emptyParsed, noteCommand, oneLine, type Parsed } from "./parsed";

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Read", "NotebookEdit"]);

// A tool result's text: a string, or a list of text blocks.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(function (b) { return isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""; })
    .join("\n");
}

function addText(parsed: Parsed, role: "user" | "assistant", text: string): void {
  // Harness notes (<system-reminder>, <command-name>, …) are not the hacker's words.
  if (role === "user" && oneLine(text).startsWith("<")) return;
  addTurn(parsed, role, text);
}

// Turns, files and where the agent works. Skips thinking, tool output, side chains, harness notes and cut lines. `into`
// carries what is already known (a branch), and is filled in.
export function parseClaude(text: string, into: Parsed = emptyParsed()): Parsed {
  const parsed = into;
  // Bash commands by tool_use id, until their result comes back.
  const commands = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // The first line of a tail read is usually cut.
      continue;
    }
    if (!isRecord(row) || row.isMeta === true || row.isSidechain === true) continue;
    const role = row.type;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof row.cwd === "string") parsed.cwd = row.cwd;
    if (typeof row.gitBranch === "string" && row.gitBranch !== "" && row.gitBranch !== "HEAD") parsed.branch = row.gitBranch;
    const message = row.message;
    if (!isRecord(message)) continue;
    // "<synthetic>" marks a reply Claude Code wrote itself (an error, a cancelled turn), not a model's.
    if (role === "assistant" && typeof message.model === "string" && message.model !== "<synthetic>") parsed.model = message.model;
    if (typeof message.content === "string") {
      addText(parsed, role, message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") addText(parsed, role, block.text);
      if (role === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
        const input = isRecord(block.input) ? block.input : {};
        if (FILE_TOOLS.has(block.name)) {
          const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
          if (file !== null) {
            addFile(parsed, file);
            addTurn(parsed, "assistant", `[${block.name} ${file}]`);
          }
        }
        if (block.name === "Bash" && typeof input.command === "string" && typeof block.id === "string") commands.set(block.id, input.command);
      }
      if (role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const command = commands.get(block.tool_use_id);
        if (command !== undefined) noteCommand(parsed, command, resultText(block.content), block.is_error !== true);
      }
    }
  }
  return parsed;
}
