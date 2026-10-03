// ABOUTME: "Knock on yourself": a knock lands on this page with a knock-knock sound and a 10-second fuse. Show me goes
// ABOUTME: to the install line, Not now sends it back, and ignoring it makes it self-destruct. More knocks queue up.

import { centerOf, lookAt } from "./bus";
import { all, calm, find, make, sleep, svg } from "./dom";
import { knockKnock } from "./sound";
import { scramble } from "./stage";
import { toast } from "./toast";
import { award } from "./xp";

const LIFETIME_MS = 10_000;
let active = false;
let waiting = 0;
let waitChip: HTMLElement | null = null;

export function startKnocks(): void {
  for (const b of all("[data-knock-me]", HTMLButtonElement)) {
    b.addEventListener("click", function () { knock(); });
  }
}

export function knock(): void {
  award("knock");
  if (active) {
    waiting = Math.min(waiting + 1, 3);
    if (waitChip !== null) {
      waitChip.hidden = false;
      waitChip.textContent = `+${waiting} waiting`;
    }
    knockKnock();
    return;
  }
  void land();
}

async function land(): Promise<void> {
  active = true;
  knockKnock();

  const card = make("div", "knock");
  card.setAttribute("role", "status");
  const ring = svg("svg", { class: "ring", viewBox: "0 0 36 36" });
  const fg = svg("circle", { class: "ring-fg", cx: "18", cy: "18", r: "15" });
  ring.append(svg("circle", { cx: "18", cy: "18", r: "15" }), fg);
  const num = make("span", "k-num", "10");
  const ringBox = make("span", "k-ring");
  ringBox.append(ring, num);

  const top = make("div", "k-top");
  const from = make("span");
  from.append(make("b", "", "@soopdoop"), document.createTextNode(" wants you to see this"));
  top.append(from, ringBox);
  const item = make("div", "k-item");
  item.append(make("span", "k-kind", "LINK"), make("span", "k-title", "the install line"), make("span", "k-note", "“copy it before this explodes”"));
  const show = make("button", "k-show", "Show me");
  const later = make("button", "", "Not now");
  show.type = "button";
  later.type = "button";
  const chip = make("span", "k-wait", "+1 waiting");
  chip.hidden = waiting === 0;
  if (waiting > 0) chip.textContent = `+${waiting} waiting`;
  waitChip = chip;
  const btns = make("div", "k-btns");
  btns.append(show, later, chip);
  card.append(top, item, btns);
  document.body.append(card);
  lookAt.emit(centerOf(card));

  // Set by the buttons while the fuse burns.
  const choice: { outcome: "opened" | "not-now" | null } = { outcome: null };
  show.addEventListener("click", function () { choice.outcome = "opened"; });
  later.addEventListener("click", function () { choice.outcome = "not-now"; });

  const start = performance.now();
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / LIFETIME_MS);
    const left = Math.ceil((LIFETIME_MS / 1000) * (1 - t));
    num.textContent = String(left);
    fg.style.strokeDashoffset = (94.25 * t).toFixed(2);
    ring.classList.toggle("low", left <= 3);
    if (choice.outcome !== null || t >= 1) break;
    await sleep(100);
  }

  if (choice.outcome === "opened") {
    card.classList.add("gone-right");
    award("opened");
    const target = find("#install", HTMLElement);
    target.scrollIntoView({ behavior: calm ? "auto" : "smooth" });
    const cmd = find(".cmd-big", HTMLElement, target);
    setTimeout(function () {
      cmd.classList.remove("flash");
      void cmd.offsetWidth;
      cmd.classList.add("flash");
    }, 700);
  } else if (choice.outcome === "not-now") {
    card.classList.add("gone-up");
    toast("Sent back. @soopdoop sees “not now”, and that’s fine.");
  } else {
    lookAt.emit(centerOf(card));
    await scramble([from, item]);
    sparks(card);
    card.classList.add("boom");
    toast("Ignored knocks self-destruct. No inbox. No guilt.");
  }
  await sleep(calm ? 50 : 760);
  card.remove();
  lookAt.emit(null);
  active = false;
  waitChip = null;
  if (waiting > 0) {
    waiting -= 1;
    await sleep(500);
    void land();
  }
}

function sparks(card: HTMLElement): void {
  if (calm) return;
  const r = card.getBoundingClientRect();
  const colors = ["var(--purple)", "var(--blue)", "var(--amber)", "#fff"];
  for (let i = 0; i < 26; i++) {
    const s = make("span", "spark");
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 130;
    s.style.left = `${r.left + Math.random() * r.width}px`;
    s.style.top = `${r.top + Math.random() * r.height}px`;
    s.style.background = colors[i % colors.length] ?? "#fff";
    s.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    s.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    document.body.append(s);
    setTimeout(function () { s.remove(); }, 900);
  }
}
