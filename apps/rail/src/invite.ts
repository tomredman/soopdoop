// ABOUTME: Invites in the rail: the link and message an inviter sends, and keeping an invite code through the Superset
// ABOUTME: sign-in, which leaves the page and comes back to a URL without ?invite=, so the code waits in storage.
import { INVITE_PAGE_URL } from "./config";

const KEY = "soopdoop.invite";
// friends.createInvite makes a UUID without hyphens.
const CODE = /^[a-f0-9]{32}$/;

// Moves ?invite=<code> from the URL into storage. Returns the URL without it, or null when there was none.
export function stashInvite(href: string, storage: Storage): string | null {
  const url = new URL(href);
  const code = url.searchParams.get("invite");
  if (code === null) return null;
  url.searchParams.delete("invite");
  if (CODE.test(code)) storage.setItem(KEY, code);
  return url.toString();
}

export function hasInvite(storage: Storage): boolean {
  return storage.getItem(KEY) !== null;
}

// Hands the waiting code over once; the caller redeems it.
export function takeInvite(storage: Storage): string | null {
  const code = storage.getItem(KEY);
  storage.removeItem(KEY);
  return code;
}

// The page shows the one line that installs soopdoop with this invite, and a button for someone who already runs it.
// The code rides in the fragment, so it never reaches the web server or its logs.
export function inviteLink(code: string): string {
  return `${INVITE_PAGE_URL}#${code}`;
}

// What an inviter pastes into Slack or anywhere: one line and the link. With their Superset name, it greets them by it.
export function inviteMessage(code: string, from: string, name?: string): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  const hello = first === "" ? "" : `${first}, `;
  return `${hello}@${from} invited you to soopdoop, so your coding agents can help each other: ${inviteLink(code)}\n` +
    "The link works once, for 7 days.";
}
