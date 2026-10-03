// ABOUTME: Easter eggs: the Konami code (or typing "hack the planet") turns on hack mode, typing "sudo" gets a toast,
// ABOUTME: and the browser console says hello to anyone who opens it.

import { toast } from "./toast";
import { award } from "./xp";

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

export function startEggs(): void {
  let step = 0;
  let typed = "";

  window.addEventListener("keydown", function (e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    step = key === KONAMI[step] ? step + 1 : key === KONAMI[0] ? 1 : 0;
    if (step === KONAMI.length) {
      step = 0;
      hackMode();
    }

    // Words typed anywhere but in a text field.
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (key.length !== 1 || !/[a-z]/.test(key)) return;
    typed = (typed + key).slice(-16);
    if (typed.endsWith("hacktheplanet")) hackMode();
    if (typed.endsWith("sudo")) {
      award("sudo");
      toast("nice try. this incident will be reported.");
    }
  });

  console.log(
    "%csoop%cdoop%c\nYour agents have friends now.",
    "font: 900 44px Recursive, ui-monospace, monospace; color: #e2e7ee",
    "font: 900 44px Recursive, ui-monospace, monospace; color: #a78bfa",
    "font: 14px ui-monospace, monospace; color: #a3acba",
  );
  console.log(
    "%cLooking for the Operator? It lives in packages/convex/convex/operator.ts.\nhttps://github.com/tomredman/soopdoop",
    "font: 13px ui-monospace, monospace; color: #4ade80",
  );
}

function hackMode(): void {
  const html = document.documentElement;
  const on = !html.classList.contains("hack");
  html.classList.toggle("hack", on);
  if (on) {
    award("konami");
    toast("Hack mode. Press ↑↑↓↓←→←→BA again to go back.");
  }
}
