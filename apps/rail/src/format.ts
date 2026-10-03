// ABOUTME: Small formatting helpers for the rail: countdowns, the knock ring, minutes of focus left, avatar initials.
// ABOUTME: Pure functions of (value, now) so they are testable and never read the clock themselves.

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

// "27" under a minute, "1:30" above it.
export function countdown(expiresAt: number, now: number): string {
  const s = secondsLeft(expiresAt, now);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : String(s);
}

// stroke-dashoffset for a ring of the given circumference: 0 when fresh, the full circumference when out of time.
export function ringOffset(circumference: number, expiresAt: number, lifetimeMs: number, now: number): number {
  const fraction = Math.min(1, Math.max(0, (expiresAt - now) / lifetimeMs));
  return circumference * (1 - fraction);
}

export function minutesLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 60_000));
}

// Two letters for an avatar: "tom" → "TO", "tom-redman" → "TR".
export function initials(handle: string): string {
  const parts = handle.split("-").filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}

// A ConvexError's message travels as its data, which production deployments pass on; there, the text of any other error
// becomes "Server Error". In development Convex wraps the text in "[CONVEX M(knocks:send)] [Request ID: …] Server
// Error\nUncaught Error: <message>\n    at …". Hackers should read only <message>.
export function cleanError(e: unknown): string {
  if (e instanceof Error && "data" in e && typeof e.data === "string") return e.data;
  const raw = e instanceof Error ? e.message : String(e);
  const match = /Uncaught (?:Convex)?Error: ([^\n]*?)(?:\s+at\s|\n|$)/.exec(raw);
  return match?.[1] ?? raw;
}
