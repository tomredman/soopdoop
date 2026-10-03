// ABOUTME: The page's smaller touches: reveal on scroll, the cursor spotlight on cards, the stage tilting toward the
// ABOUTME: pointer, the nav's edge, the endless ticker, copy buttons, the sound switch and the "Level up" card's loop.

import { all, calm, find, sleep, visibility } from "./dom";
import { RANKS } from "./game";
import { setSound, soundOn } from "./sound";
import { toast } from "./toast";
import { award } from "./xp";

export function startReveal(): void {
  const io = new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  // Things revealed together come in one after another.
  let last: Element | null = null;
  let n = 0;
  for (const el of all("[data-reveal]", HTMLElement)) {
    n = el.parentElement === last ? n + 1 : 0;
    last = el.parentElement;
    if (n > 0) el.style.setProperty("--d", `${Math.min(n, 6) * 70}ms`);
    io.observe(el);
  }
}

export function startSpotlight(): void {
  for (const card of all("[data-spot]", HTMLElement)) {
    card.addEventListener("pointermove", function (e) {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, { passive: true });
  }
}

export function startTilt(): void {
  if (calm || !matchMedia("(hover: hover) and (min-width: 961px)").matches) return;
  const stage = find("[data-stage]", HTMLElement);
  stage.addEventListener("pointermove", function (e) {
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    stage.style.setProperty("--ry", `${(x * 7).toFixed(2)}deg`);
    stage.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
  }, { passive: true });
  stage.addEventListener("pointerleave", function () {
    stage.style.setProperty("--ry", "0deg");
    stage.style.setProperty("--rx", "0deg");
  });
}

export function startNav(): void {
  const nav = find("[data-nav]", HTMLElement);
  function update(): void { nav.classList.toggle("scrolled", scrollY > 8); }
  window.addEventListener("scroll", update, { passive: true });
  update();
}

// Two copies of the ticker's items, so the loop never shows a seam.
export function startTicker(): void {
  const track = find("[data-ticker]", HTMLElement);
  for (const item of Array.from(track.children)) track.append(item.cloneNode(true));
}

export function startCopy(): void {
  for (const button of all("[data-copy]", HTMLButtonElement)) {
    button.addEventListener("click", function () { void copy(button); });
  }
}

async function copy(button: HTMLButtonElement): Promise<void> {
  const text = button.dataset.copy ?? "";
  const label = button.querySelector("[data-copy-label]");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard access: select the command so ⌘C works.
    const code = button.querySelector("code");
    const selection = getSelection();
    if (code !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    toast("Selected. Press ⌘C to copy.");
    return;
  }
  button.classList.add("copied");
  if (label !== null) label.textContent = "copied ✓";
  award("copy");
  await sleep(1800);
  button.classList.remove("copied");
  if (label !== null) label.textContent = "copy";
}

export function startSoundSwitch(): void {
  const button = find("[data-sound]", HTMLButtonElement);
  function show(): void {
    const on = soundOn();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Sound on" : "Sound off");
  }
  button.addEventListener("click", function () {
    setSound(!soundOn());
    show();
    toast(soundOn() ? "Sound on. Knocks knock." : "Sound off. Knocks are silent now.");
  });
  show();
}

// The "Level up" card climbs the ladder again and again while it is on screen.
export function startLevelCard(): void {
  const chip = find("[data-cycle-rank]", HTMLElement);
  const xp = find("[data-cycle-xp]", HTMLElement);
  const bar = find("[data-cycle-bar]", HTMLElement);
  const card = chip.closest(".card") ?? chip;
  const seen = visibility(card);
  async function run(): Promise<void> {
    for (let i = 0; ; i = (i + 1) % RANKS.length) {
      const rank = RANKS[i];
      const next = RANKS[i + 1];
      if (rank === undefined) continue;
      chip.textContent = rank.name;
      const to = next === undefined ? rank.at : next.at;
      for (let k = 0; k <= 10; k++) {
        const value = Math.round(rank.at + ((to - rank.at) * k) / 10);
        xp.textContent = String(value);
        bar.style.setProperty("--p", next === undefined ? "1" : String(k / 10));
        await sleep(calm ? 0 : 90);
      }
      await sleep(900);
      while (!seen.on || document.hidden) await sleep(400);
    }
  }
  void run();
}

export function startJsFlag(): void {
  document.documentElement.classList.add("js-ok");
  // Pause SMIL animations (the little relay in the Operator card) for reduced motion.
  if (calm) for (const s of all("svg", SVGSVGElement)) s.pauseAnimations();
}
