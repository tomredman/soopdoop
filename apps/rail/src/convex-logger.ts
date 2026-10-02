// ABOUTME: A logger for the Convex client that remembers why Convex refused a sign-in token, so the rail can say so.
// ABOUTME: Without it the reason only reaches the console and the page sits on "connecting…".

// The two lines the Convex client writes when the server rejects a token (convex 1.46, authentication_manager.js).
const FINAL = /^Failed to authenticate: "([\s\S]*)", check your server auth config$/;
const RETRYING = /^attempting to reauthenticate: ([\s\S]*)$/;

export function authFailureReason(line: string): string | null {
  const match = FINAL.exec(line) ?? RETRYING.exec(line);
  return match?.[1] ?? null;
}

function firstString(args: unknown[]): string | null {
  const first = args[0];
  return typeof first === "string" ? first : null;
}

// Same shape as convex's Logger. Verbose lines are only read, never printed: some carry the end of a token.
export function railLogger(onAuthFailure: (reason: string) => void) {
  function watch(args: unknown[]): void {
    const line = firstString(args);
    const reason = line === null ? null : authFailureReason(line);
    if (reason !== null) onAuthFailure(reason);
  }
  return {
    logVerbose(...args: unknown[]): void {
      watch(args);
    },
    log(...args: unknown[]): void {
      console.log(...args);
    },
    warn(...args: unknown[]): void {
      console.warn(...args);
    },
    error(...args: unknown[]): void {
      watch(args);
      console.error(...args);
    },
  };
}
