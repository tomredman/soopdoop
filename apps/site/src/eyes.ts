// ABOUTME: The wordmark's o's are eyes. They follow the pointer, wander when it is still (or on touch screens), blink
// ABOUTME: now and then, look at whatever the page points them at (a knock), and squint when poked.

import { lookAt } from "./bus";
import { all, calm } from "./dom";
import { award } from "./xp";

interface Eye {
  ring: HTMLElement;
  pupil: HTMLElement;
  x: number;
  y: number;
}

export function startEyes(): void {
  const eyes: Eye[] = [];
  for (const ring of all(".wm-eye", HTMLElement)) {
    const pupil = ring.querySelector(".wm-pupil");
    if (pupil instanceof HTMLElement) eyes.push({ ring, pupil, x: 0, y: 0 });
  }
  if (eyes.length === 0) return;

  let pointer: { x: number; y: number } | null = null;
  let movedAt = -Infinity;
  let forced: { x: number; y: number } | null = null;
  let wander = { x: innerWidth * 0.5, y: innerHeight * 0.75 };
  let nextWander = 0;

  function track(e: PointerEvent): void {
    pointer = { x: e.clientX, y: e.clientY };
    movedAt = performance.now();
  }
  window.addEventListener("pointermove", track, { passive: true });
  window.addEventListener("pointerdown", track, { passive: true });
  lookAt.on(function (p) { forced = p; });

  // Only work while some wordmark is on screen.
  const showing = new Set<Element>();
  const io = new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (e.isIntersecting) showing.add(e.target);
      else showing.delete(e.target);
    }
  });
  for (const w of all("[data-wordmark]", HTMLElement)) io.observe(w);

  function frame(now: number): void {
    requestAnimationFrame(frame);
    if (showing.size === 0 || document.hidden) return;
    const idle = now - movedAt > 3500;
    if (idle && now > nextWander) {
      wander = { x: innerWidth * (0.1 + Math.random() * 0.8), y: innerHeight * (0.15 + Math.random() * 0.85) };
      nextWander = now + 1400 + Math.random() * 2600;
    }
    const target = forced ?? (idle ? null : pointer) ?? wander;
    // Read every position first, then write, so the browser lays out once per frame.
    const rects = eyes.map(function (eye) { return eye.ring.getBoundingClientRect(); });
    eyes.forEach(function (eye, i) {
      const r = rects[i];
      if (r === undefined || r.bottom < 0 || r.top > innerHeight) return;
      const dx = target.x - (r.left + r.width / 2);
      const dy = target.y - (r.top + r.height / 2);
      const d = Math.max(1, Math.hypot(dx, dy));
      // How far a pupil can travel inside its ring, and how quickly it gets there.
      const reach = Math.min(r.width * 0.135, d * 0.1);
      const ease = calm ? 1 : forced !== null ? 0.25 : 0.16;
      eye.x += ((dx / d) * reach - eye.x) * ease;
      eye.y += ((dy / d) * reach - eye.y) * ease;
      eye.pupil.style.transform = `translate(${eye.x.toFixed(2)}px, ${eye.y.toFixed(2)}px)`;
    });
  }
  requestAnimationFrame(frame);

  for (const pair of all(".wm-pair", HTMLElement)) {
    if (!calm) blinkLater(pair);
    pair.addEventListener("click", function () {
      pair.classList.add("ouch");
      setTimeout(function () { pair.classList.remove("ouch"); }, 650);
      award("poke");
    });
  }
}

function blinkLater(pair: HTMLElement): void {
  setTimeout(function () {
    blink(pair);
    // Now and then, a double blink.
    if (Math.random() < 0.25) setTimeout(function () { blink(pair); }, 260);
    blinkLater(pair);
  }, 2400 + Math.random() * 4600);
}

function blink(pair: HTMLElement): void {
  pair.classList.add("blink");
  setTimeout(function () { pair.classList.remove("blink"); }, 120);
}
