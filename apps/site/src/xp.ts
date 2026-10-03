// ABOUTME: Visitor XP: this page plays the app's game. Reading, asking the canned Operator, knocking and copying the
// ABOUTME: install line earn XP toward the app's ranks. Saved in localStorage when it can be; fine without it.

import { all, calm, find, make } from "./dom";
import { ASK_LIMIT, QUESTS, rankFor } from "./game";
import { blip, chime } from "./sound";
import { toast } from "./toast";

interface Saved {
  xp: number;
  done: string[];
  asks: number;
}

const KEY = "soopdoop.site.xp";
const saved: Saved = load();
let shownXp = saved.xp;

function load(): Saved {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw === "object" && raw !== null && "xp" in raw && "done" in raw && "asks" in raw) {
      const { xp, done, asks } = raw;
      if (typeof xp === "number" && Array.isArray(done) && typeof asks === "number") {
        return { xp, done: done.filter(function (d): d is string { return typeof d === "string"; }), asks };
      }
    }
  } catch {
    // Nothing saved yet, or no storage in this window.
  }
  return { xp: 0, done: [], asks: 0 };
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // A private window: XP lasts until the page closes.
  }
}

export function award(key: string): void {
  const quest = QUESTS.find(function (q) { return q.key === key; });
  if (quest === undefined) return;
  if (key === "ask") {
    if (saved.asks >= ASK_LIMIT) return;
    saved.asks += 1;
    if (saved.asks === ASK_LIMIT) saved.done.push("ask");
  } else {
    if (saved.done.includes(key)) return;
    saved.done.push(key);
  }
  const before = rankFor(saved.xp).rank.name;
  saved.xp += quest.xp;
  save();
  const after = rankFor(saved.xp).rank.name;
  render(true);
  toast(quest.said, { strong: `+${quest.xp} XP`, big: quest.xp >= 10 });
  blip();
  if (after !== before) setTimeout(function () { rankUp(after); }, 450);
}

function rankUp(name: string): void {
  const box = make("div", "rankup");
  box.setAttribute("role", "status");
  box.append(make("small", "", "RANK UP"), make("strong", "", name));
  document.body.append(box);
  setTimeout(function () { box.remove(); }, 3000);
  chime();
  if (!calm) confetti(find("[data-me-toggle]", HTMLElement));
}

function confetti(from: HTMLElement): void {
  const r = from.getBoundingClientRect();
  const colors = ["var(--green)", "var(--blue)", "var(--purple)", "var(--amber)"];
  for (let i = 0; i < 28; i++) {
    const s = make("span", "spark");
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
    const dist = 60 + Math.random() * 140;
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    s.style.background = colors[i % colors.length] ?? "var(--green)";
    s.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    s.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    document.body.append(s);
    setTimeout(function () { s.remove(); }, 900);
  }
}

function countUp(el: HTMLElement, to: number): void {
  const from = shownXp;
  shownXp = to;
  if (calm || from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  function step(now: number): void {
    const t = Math.min(1, (now - start) / 650);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function render(bump: boolean): void {
  const { rank, progress } = rankFor(saved.xp);
  const me = find("[data-me]", HTMLElement);
  find("[data-me-rank]", HTMLElement, me).textContent = rank.name;
  countUp(find("[data-me-xp]", HTMLElement, me), saved.xp);
  find("[data-me-bar]", HTMLElement, me).style.setProperty("--p", progress.toFixed(3));
  if (bump && !calm) {
    me.classList.remove("bump");
    void me.offsetWidth;
    me.classList.add("bump");
  }

  for (const li of all("[data-ladder] li", HTMLElement)) li.classList.toggle("here", li.dataset.rank === rank.name);
  for (const el of all("[data-you-are]", HTMLElement)) el.textContent = `You are a ${rank.name}.`;

  const list = find("[data-quest-list]", HTMLElement);
  list.replaceChildren(...QUESTS.map(function (q) {
    const done = saved.done.includes(q.key);
    const li = make("li", done ? "done" : "");
    const label = q.secret === true && !done ? "???" : q.key === "ask" ? `${q.label} (${saved.asks}/${ASK_LIMIT})` : q.label;
    li.append(make("span", "", label), make("b", "", `+${q.xp}`));
    return li;
  }));

  const text = `I'm a ${rank.name} on soopdoop 👀 my agents have friends now`;
  find("[data-share]", HTMLAnchorElement).href =
    `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent("https://soopdoop.com")}`;
}

export function startXp(): void {
  render(false);

  const toggle = find("[data-me-toggle]", HTMLButtonElement);
  const panel = find("[data-quests]", HTMLElement);
  function setOpen(open: boolean): void {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }
  toggle.addEventListener("click", function () { setOpen(panel.hidden); });
  document.addEventListener("click", function (e) {
    if (!panel.hidden && e.target instanceof Node && !find("[data-me]", HTMLElement).contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });

  // Reading a section earns its XP once, when most of its top is on screen.
  const io = new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (!e.isIntersecting || !(e.target instanceof HTMLElement)) continue;
      io.unobserve(e.target);
      award(`read:${e.target.dataset.xpSection ?? ""}`);
    }
  }, { rootMargin: "0px 0px -45% 0px" });
  for (const s of all("[data-xp-section]", HTMLElement)) io.observe(s);
}
