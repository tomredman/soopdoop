// ABOUTME: What each harness hook runs: reads the hook payload on stdin and posts the few fields the daemon uses. It never
// ABOUTME: fails. It prints only on session start and prompts: the crew introduction the daemon sends back. It imports nothing heavy.
import { isRecord, parseHookEvent } from "./state";

const PORT = Number(process.env.SOOPDOOP_PORT ?? "47311");
// Events whose hook can add text to the session's context. The daemon may answer these with the crew's agents.
const SPEAKING = new Set(["SessionStart", "UserPromptSubmit"]);

function printOut(text: string): void {
  process.stdout.write(text);
}

// Prompts and tool inputs stay out: only the event name, session id, cwd, transcript path and message cross the socket.
export async function forwardHook(event: string, raw: string, port: number = PORT, write: (text: string) => void = printOut): Promise<void> {
  try {
    const payload: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    const fields = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
    const ev = parseHookEvent({ ...fields, hook_event_name: event });
    if (ev === null) return;
    const speaking = SPEAKING.has(event);
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      // A session's start can wait a moment for the crew; every other event is fire and forget.
      signal: AbortSignal.timeout(speaking ? 3_000 : 1_500),
    });
    if (!speaking || !(res.headers.get("content-type") ?? "").includes("application/json")) return;
    const reply: unknown = await res.json();
    if (!isRecord(reply) || typeof reply.context !== "string" || reply.context === "") return;
    // Claude Code adds additionalContext to the session as a system reminder.
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }) + "\n");
  } catch {
    // The daemon is not running, or the payload was odd. The harness must never notice.
  }
}

if (import.meta.main) {
  await forwardHook(Bun.argv[2] ?? "", await Bun.stdin.text());
}
