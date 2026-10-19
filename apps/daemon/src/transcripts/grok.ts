// ABOUTME: Reads Grok sessions (<GROK_HOME>/sessions/<url-encoded folder>/<id>/chat_history.jsonl, and summary.json beside it): the
// ABOUTME: hacker's prompts, the agent's replies, its model, the files its tools touched, its PRs and merges, and where it works.
import { isRecord } from "../state";
import { addFile, addTurn, emptyParsed, noteCommand, type Parsed } from "./parsed";

const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["search_replace", "write", "edit_file", "write_file", "create_file"]);

// Grok names a session's group folder after the session's folder, percent-encoded like a URL component (RFC 3986: only
// letters, digits and -._~ stay as they are). A name over 255 bytes is a slug and a hash instead; findTranscript then looks
// through every group.
export function grokFolderName(cwd: string): string {
  return encodeURIComponent(cwd).replace(/[!'()*]/g, function (c) { return `%${c.charCodeAt(0).toString(16).toUpperCase()}`; });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(function (b) { return isRecord(b) && typeof b.text === "string" ? b.text : ""; })
    .join("\n");
}

function args(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// A terminal command's result starts with its exit code: "exit: 0\n<output>".
function terminalResult(content: string): { ok: boolean | undefined; output: string } {
  const m = /^exit: (-?\d+)\r?\n?/.exec(content);
  if (m === null) return { ok: undefined, output: content };
  return { ok: Number(m[1]) === 0, output: content.slice(m[0].length) };
}

// Turns, files and model. The system prompt, injected reminders (no prompt_index), reasoning and tool output are skipped.
// `into` carries what summary.json said (the folder and the branch), and is filled in.
export function parseGrok(text: string, into: Parsed = emptyParsed()): Parsed {
  const parsed = into;
  // Terminal commands by tool call id, until their result comes back.
  const commands = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    if (row.type === "user") {
      // The hacker's prompts carry their number; reminders and project instructions Grok adds do not.
      if (typeof row.prompt_index === "number" && row.synthetic_reason === undefined) addTurn(parsed, "user", contentText(row.content));
      continue;
    }
    if (row.type === "assistant") {
      if (typeof row.model_id === "string" && row.model_id !== "") parsed.model = row.model_id;
      addTurn(parsed, "assistant", contentText(row.content));
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        if (!isRecord(call) || typeof call.name !== "string") continue;
        const input = args(call.arguments);
        const file = typeof input.target_file === "string" ? input.target_file : typeof input.file_path === "string" ? input.file_path : null;
        if (file !== null && (READ_TOOLS.has(call.name) || WRITE_TOOLS.has(call.name))) {
          addFile(parsed, file);
          addTurn(parsed, "assistant", `[${call.name} ${file}]`);
        }
        if (call.name === "run_terminal_command" && typeof input.command === "string" && typeof call.id === "string") commands.set(call.id, input.command);
      }
      continue;
    }
    if (row.type === "tool_result" && typeof row.tool_call_id === "string") {
      const command = commands.get(row.tool_call_id);
      if (command === undefined) continue;
      const result = terminalResult(contentText(row.content));
      noteCommand(parsed, command, result.output, result.ok);
    }
  }
  return parsed;
}

// What summary.json says about the session: its folder, the branch it is on and its model. Read before the chat history,
// so a merge on main is known as one.
export function grokSummary(raw: unknown): Parsed {
  const parsed = emptyParsed();
  if (!isRecord(raw)) return parsed;
  const info = isRecord(raw.info) ? raw.info : {};
  if (typeof info.cwd === "string") parsed.cwd = info.cwd;
  if (typeof raw.head_branch === "string" && raw.head_branch !== "" && raw.head_branch !== "HEAD") parsed.branch = raw.head_branch;
  if (typeof raw.current_model_id === "string" && raw.current_model_id !== "") parsed.model = raw.current_model_id;
  return parsed;
}
