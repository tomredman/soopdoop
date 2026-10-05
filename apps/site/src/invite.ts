// ABOUTME: The invite page (invite.html): reads the code from the link's fragment and fills in the one line that installs
// ABOUTME: soopdoop with it, and the link for someone who already runs soopdoop. Nothing is sent anywhere.

// friends.createInvite makes a UUID without hyphens.
const CODE = /^[a-f0-9]{32}$/;
const INSTALL_URL = "https://soopdoop.com/install";
// The local agent every install runs. It redeems ?invite= after the Superset sign-in.
const RAIL_ORIGIN = "http://127.0.0.1:47312";

// The code from "#<code>", or null when the link lost it or it is not one.
export function inviteCode(hash: string): string | null {
  const code = hash.replace(/^#/, "").trim().toLowerCase();
  return CODE.test(code) ? code : null;
}

export function installLine(code: string): string {
  return `curl -fsSL ${INSTALL_URL} | bash -s -- --invite ${code}`;
}

export function acceptUrl(code: string): string {
  return `${RAIL_ORIGIN}/?invite=${code}`;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`soopdoop: no #${id}`);
  return found;
}

async function copy(button: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    // No clipboard access: select the line so ⌘C works.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(byId("line"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    button.textContent = "Press ⌘C";
  }
  setTimeout(function () { button.textContent = "Copy"; }, 2_000);
}

function main(): void {
  const code = inviteCode(location.hash);
  if (code === null) {
    byId("missing").hidden = false;
    return;
  }
  const line = installLine(code);
  byId("line").textContent = line;
  const accept = byId("accept");
  if (accept instanceof HTMLAnchorElement) accept.href = acceptUrl(code);
  const button = byId("copy");
  button.addEventListener("click", function () { void copy(button, line); });
  byId("ready").hidden = false;
}

if (typeof document !== "undefined") main();
