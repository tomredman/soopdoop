// ABOUTME: The rail's version line and update notice: which soopdoop runs, whether a newer release is out, "Update now"
// ABOUTME: (the background updater installs it and restarts the rail), the auto-update switch, and a note after an update.
import { RELEASES_URL } from "./config";
import { byId, input } from "./dom";
import { postLocal, readLocal, type Local } from "./local-api";

const SEEN_KEY = "soopdoop.seenVersion";
const POLL_MS = 2_000;
const GIVE_UP_MS = 3 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function render(local: Local): void {
  const version = byId("version");
  version.textContent = `v${local.version}`;
  version.setAttribute("href", `${RELEASES_URL}/tag/v${local.version}`);
  const note = byId("updateNote");
  const text = byId("updateText");
  const button = byId("updateBtn");
  const link = byId("updateLink");
  button.hidden = true;
  link.hidden = true;
  if (local.updating) {
    note.hidden = false;
    text.textContent = "Updating soopdoop. The rail comes back in a moment.";
    return;
  }
  if (local.newer && local.latest !== null) {
    note.hidden = false;
    text.textContent = local.canUpdate
      ? `soopdoop ${local.latest} is out.${local.autoUpdate ? " It installs itself within 6 hours." : ""}`
      : `soopdoop ${local.latest} is out. Run \`soopdoop update\` in Terminal.`;
    button.hidden = !local.canUpdate;
    if (local.releaseUrl !== null) {
      link.setAttribute("href", local.releaseUrl);
      link.hidden = false;
    }
    return;
  }
  note.hidden = local.updateError === null;
  text.textContent = local.updateError ?? "";
}

// After an update the rail restarts with a new version; say so once.
function announce(local: Local, flash: (message: string) => void): void {
  try {
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen !== null && seen !== local.version) flash(`soopdoop updated to v${local.version}.`);
    localStorage.setItem(SEEN_KEY, local.version);
  } catch {
    // Storage can be off; the note is only a courtesy.
  }
}

async function updateNow(before: Local, flash: (message: string) => void): Promise<void> {
  const res = await postLocal("/local/update", {});
  if (!res.ok) {
    flash(res.error ?? "Could not start the update.");
    return;
  }
  render({ ...before, updating: true });
  const until = Date.now() + GIVE_UP_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const now = await readLocal();
    // The rail server restarts during the update; a new version means it is done.
    if (now !== null && now.version !== before.version) {
      location.reload();
      return;
    }
    if (now !== null && !now.updating && now.updateError !== null && now.updateError !== before.updateError) {
      render(now);
      flash(now.updateError);
      return;
    }
  }
  flash("The update is taking a while. `soopdoop status` in Terminal says what is happening.");
}

export function mountUpdates(local: Local, flash: (message: string) => void): void {
  render(local);
  announce(local, flash);
  const auto = input("autoUpdate");
  auto.checked = local.autoUpdate;
  auto.addEventListener("change", function () {
    void postLocal("/local/settings", { autoUpdate: auto.checked }).then(function (res) {
      if (!res.ok) {
        auto.checked = !auto.checked;
        flash(res.error ?? "Could not change the setting.");
        return;
      }
      flash(auto.checked ? "New releases install themselves within 6 hours." : "Auto-update off. The rail says when a release is out.");
    });
  });
  byId("updateBtn").addEventListener("click", function () { void updateNow(local, flash); });
}
