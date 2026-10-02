// ABOUTME: What each harness hook runs: reads the hook payload on stdin and posts the few fields the daemon uses.
// ABOUTME: Imports nothing heavy so it starts fast; it runs on every tool call in every session. It never fails and never prints.
import { parseHookEvent } from "./state";

const PORT = Number(process.env.SOOPDOOP_PORT ?? "47311");

// Prompts and tool inputs stay out: only the event name, session id, cwd, transcript path and message cross the socket.
export async function forwardHook(event: string, raw: string, port: number = PORT): Promise<void> {
  try {
    const payload: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    const fields = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
    const ev = parseHookEvent({ ...fields, hook_event_name: event });
    if (ev === null) return;
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // The daemon is not running, or the payload was odd. The harness must never notice.
  }
}

if (import.meta.main) {
  await forwardHook(Bun.argv[2] ?? "", await Bun.stdin.text());
}
