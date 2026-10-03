// ABOUTME: Small DOM helpers: find elements with a type check instead of a cast, make elements, wait, and the shared
// ABOUTME: "reduce motion" flag that every animation checks.

type Kind<T> = { new (): T; prototype: T };

export function find<T extends Element>(selector: string, kind: Kind<T>, root: ParentNode = document): T {
  const found = root.querySelector(selector);
  if (!(found instanceof kind)) throw new Error(`soopdoop: nothing matches ${selector}`);
  return found;
}

export function all<T extends Element>(selector: string, kind: Kind<T>, root: ParentNode = document): T[] {
  const out: T[] = [];
  for (const e of root.querySelectorAll(selector)) if (e instanceof kind) out.push(e);
  return out;
}

export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== "") e.className = className;
  if (text !== "") e.textContent = text;
  return e;
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

export function pick<T>(items: readonly T[], fallback: T): T {
  return items[Math.floor(Math.random() * items.length)] ?? fallback;
}

export const calm: boolean = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Calls back once the element has been on screen, then stops watching.
export function onceSeen(el: Element, fn: () => void, threshold = 0.3): void {
  const io = new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.disconnect();
      fn();
    }
  }, { threshold });
  io.observe(el);
}

// Tracks whether an element is on screen, for animations that should rest when nobody can see them.
export function visibility(el: Element, threshold = 0): { readonly on: boolean } {
  const state = { on: false };
  new IntersectionObserver(function (entries) {
    for (const e of entries) state.on = e.isIntersecting;
  }, { threshold }).observe(el);
  return state;
}
