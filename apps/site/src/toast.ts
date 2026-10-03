// ABOUTME: Short messages in the bottom right that leave by themselves, like the app's toasts. Built from DOM nodes, so
// ABOUTME: nothing is ever parsed as HTML. At most four stay on screen.

import { find, make } from "./dom";

export function toast(text: string, opts: { strong?: string; big?: boolean; ms?: number } = {}): void {
  const box = find("[data-toasts]", HTMLElement);
  const t = make("div", opts.big === true ? "toast big" : "toast");
  if (opts.strong !== undefined) t.append(make("b", "", opts.strong));
  t.append(make("span", "", text));
  box.append(t);
  while (box.children.length > 4) box.firstElementChild?.remove();
  setTimeout(function () {
    t.classList.add("out");
    setTimeout(function () { t.remove(); }, 400);
  }, opts.ms ?? 3200);
}
