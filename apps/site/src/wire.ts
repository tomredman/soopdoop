// ABOUTME: The hero's background: a slow network of hackers (green working, blue idle) where purple relays run along
// ABOUTME: the links and land green. Rests off screen and in background tabs; one still frame for reduced motion.

import { calm, find, visibility } from "./dom";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  r: number;
  flash: number;
}

interface Relay {
  a: Node;
  b: Node;
  t: number;
  speed: number;
}

const GREEN = "74, 222, 128";
const BLUE = "96, 165, 250";
const PURPLE = "167, 139, 250";
const GREY = "138, 148, 163";
const LINK = 150;

export function startWire(): void {
  const canvas = find("[data-hero-wire]", HTMLCanvasElement);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const draw2d = ctx;
  const hero = canvas.parentElement ?? canvas;
  const seen = visibility(hero);
  let width = 0;
  let height = 0;
  let nodes: Node[] = [];
  const relays: Relay[] = [];
  let nextRelay = 0;
  let pointer: { x: number; y: number } | null = null;

  function seed(): void {
    const ratio = Math.min(2, window.devicePixelRatio);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    draw2d.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.max(14, Math.min(48, Math.round((width * height) / 24000)));
    nodes = Array.from({ length: count }, function () {
      const roll = Math.random();
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        color: roll < 0.4 ? GREEN : roll < 0.75 ? BLUE : GREY,
        r: 1.6 + Math.random() * 1.6,
        flash: 0,
      };
    });
    relays.length = 0;
  }

  function near(a: Node, b: Node): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function spawn(now: number): void {
    nextRelay = now + 700 + Math.random() * 1100;
    const a = nodes[Math.floor(Math.random() * nodes.length)];
    if (a === undefined) return;
    const options = nodes.filter(function (n) { return n !== a && near(a, n) < LINK; });
    const b = options[Math.floor(Math.random() * options.length)];
    if (b === undefined) return;
    relays.push({ a, b, t: 0, speed: 0.008 + Math.random() * 0.008 });
  }

  function paint(now: number, move: boolean): void {
    draw2d.clearRect(0, 0, width, height);
    if (move) {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = width + 20;
        if (n.x > width + 20) n.x = -20;
        if (n.y < -20) n.y = height + 20;
        if (n.y > height + 20) n.y = -20;
        n.flash = Math.max(0, n.flash - 0.02);
      }
    }
    // Links between nearby hackers, and to the pointer when it is close.
    draw2d.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (b === undefined) continue;
        const d = near(a, b);
        if (d > LINK) continue;
        draw2d.strokeStyle = `rgba(${GREY}, ${(0.13 * (1 - d / LINK)).toFixed(3)})`;
        draw2d.beginPath();
        draw2d.moveTo(a.x, a.y);
        draw2d.lineTo(b.x, b.y);
        draw2d.stroke();
      }
      if (pointer !== null) {
        const d = Math.hypot(a.x - pointer.x, a.y - pointer.y);
        if (d < 170) {
          draw2d.strokeStyle = `rgba(${BLUE}, ${(0.28 * (1 - d / 170)).toFixed(3)})`;
          draw2d.beginPath();
          draw2d.moveTo(a.x, a.y);
          draw2d.lineTo(pointer.x, pointer.y);
          draw2d.stroke();
        }
      }
    }
    for (const n of nodes) {
      draw2d.fillStyle = `rgba(${n.color}, 0.85)`;
      draw2d.beginPath();
      draw2d.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      draw2d.fill();
      if (n.flash > 0) {
        draw2d.strokeStyle = `rgba(${GREEN}, ${n.flash.toFixed(3)})`;
        draw2d.beginPath();
        draw2d.arc(n.x, n.y, n.r + (1 - n.flash) * 16, 0, Math.PI * 2);
        draw2d.stroke();
      }
    }
    // Relays in flight: purple dots with a glow, landing green.
    if (move && now > nextRelay) spawn(now);
    for (let i = relays.length - 1; i >= 0; i--) {
      const r = relays[i];
      if (r === undefined) continue;
      if (move) r.t += r.speed;
      if (r.t >= 1) {
        r.b.flash = 1;
        relays.splice(i, 1);
        continue;
      }
      const x = r.a.x + (r.b.x - r.a.x) * r.t;
      const y = r.a.y + (r.b.y - r.a.y) * r.t;
      draw2d.strokeStyle = `rgba(${PURPLE}, 0.35)`;
      draw2d.beginPath();
      draw2d.moveTo(r.a.x, r.a.y);
      draw2d.lineTo(x, y);
      draw2d.stroke();
      const glow = draw2d.createRadialGradient(x, y, 0, x, y, 10);
      glow.addColorStop(0, `rgba(${PURPLE}, 0.9)`);
      glow.addColorStop(1, `rgba(${PURPLE}, 0)`);
      draw2d.fillStyle = glow;
      draw2d.beginPath();
      draw2d.arc(x, y, 10, 0, Math.PI * 2);
      draw2d.fill();
    }
  }

  seed();
  new ResizeObserver(function () {
    seed();
    if (calm) paint(0, false);
  }).observe(canvas);
  hero.addEventListener("pointermove", function (e) {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  }, { passive: true });
  hero.addEventListener("pointerleave", function () { pointer = null; });

  if (calm) {
    paint(0, false);
    return;
  }
  function frame(now: number): void {
    requestAnimationFrame(frame);
    if (!seen.on || document.hidden) return;
    paint(now, true);
  }
  requestAnimationFrame(frame);
}
