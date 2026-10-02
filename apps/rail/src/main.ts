// ABOUTME: Boots the rail: loads config, finishes a Superset sign-in if one is coming back, connects to Convex,
// ABOUTME: then shows the sign-in screen, the handle screen, or the rail itself.
import { ConvexClient } from "convex/browser";
import { api } from "@soopdoop/convex/convex/_generated/api";
import { RAIL_ORIGIN, loadConfig } from "./config";
import { railLogger } from "./convex-logger";
import { byId, input } from "./dom";
import { cleanError } from "./format";
import { mountRail } from "./rail";
import { beginSignIn, completeSignIn, currentSession, fetchIdToken, signOut } from "./superset-auth";

type Screen = "boot" | "error" | "signin" | "handle" | "rail";
const SCREENS: Screen[] = ["boot", "error", "signin", "handle", "rail"];

function showScreen(name: Screen): void {
  for (const s of SCREENS) byId(`screen-${s}`).hidden = s !== name;
}

function showError(message: string): void {
  byId("errorText").textContent = message;
  showScreen("error");
}

function signInNote(message: string): void {
  const note = byId("signinNote");
  note.textContent = message;
  note.hidden = false;
}

async function boot(): Promise<void> {
  // The OAuth redirect is registered for 127.0.0.1; a localhost tab would come back to the wrong origin.
  if (location.hostname === "localhost") {
    location.replace(RAIL_ORIGIN + location.pathname + location.search);
    return;
  }
  showScreen("boot");
  const config = await loadConfig();
  byId("signin").addEventListener("click", function () { void beginSignIn(); });

  const finished = await completeSignIn();
  if (finished instanceof Error) signInNote(finished.message);
  if (currentSession() === null) {
    showScreen("signin");
    return;
  }

  // Remembers why Convex refused the token, if it does; the default logger only prints that to the console.
  let refusal: string | null = null;
  const client = new ConvexClient(config.convexUrl, {
    logger: railLogger(function (reason) { refusal = reason; }),
  });
  function leave(): void {
    signOut();
    void client.close();
    location.replace(RAIL_ORIGIN + "/");
  }

  let watching = false;
  client.setAuth(fetchIdToken, function (authenticated) {
    if (!authenticated) {
      // Convex gave up on the token: the server refused it, or it ran out and could not be refreshed.
      // The session is no use either way, so drop it and say why.
      signOut();
      showScreen("signin");
      signInNote(refusal === null
        ? "Your Superset sign-in ended. Sign in again."
        : `Convex did not accept the Superset sign-in: ${refusal}`);
      return;
    }
    if (watching) return;
    watching = true;
    client.onUpdate(api.hackers.me, {}, function (current) {
      if (current === null) {
        showScreen("handle");
        input("handleInput").focus();
        return;
      }
      showScreen("rail");
      mountRail(client, current, { convexUrl: config.convexUrl, onSignOut: leave });
    }, function (e) { showError(cleanError(e)); });
  });

  byId("handleForm").addEventListener("submit", function (event) {
    event.preventDefault();
    const err = byId("handleError");
    err.hidden = true;
    client.mutation(api.hackers.claimHandle, { handle: input("handleInput").value.trim().replace(/^@/, "") }).catch(function (e: unknown) {
      err.textContent = cleanError(e);
      err.hidden = false;
    });
  });
}

void boot().catch(function (e: unknown) { showError(cleanError(e)); });
