// ABOUTME: Invites in the rail: the message an inviter sends, and keeping an invite code through the Superset sign-in.
// ABOUTME: Sign-in leaves the page and comes back to a URL without ?invite=, so the code waits in storage until redeemed.
import { INSTALL_DIR, RAIL_ORIGIN, REPO_URL } from "./config";

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

// One line installs soopdoop and opens the invite (or just opens it, when soopdoop is already there).
// The plain link is for someone who already runs soopdoop.
export function inviteMessage(code: string, from: string): string {
  return [
    `@${from} invited you to soopdoop. Paste this into Terminal:`,
    "",
    `[ -d ${INSTALL_DIR} ] || git clone ${REPO_URL} ${INSTALL_DIR}; ${INSTALL_DIR}/bin/soopdoop setup --invite ${code}`,
    "",
    `Already running soopdoop? Open ${RAIL_ORIGIN}/?invite=${code}`,
    "The invite works once, for 7 days.",
  ].join("\n");
}
