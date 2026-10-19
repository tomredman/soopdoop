// ABOUTME: The quieter pages (teams, privacy, terms): the nav's edge once the page scrolls, reveal on scroll, and copy
// ABOUTME: buttons for the install line. No XP, sound or demo, so none of the home page's game loads here.

import { all, find, sleep } from "./dom";

// As on the home page (fx.ts): the flag lets the CSS hide [data-reveal] until it scrolls in, and things revealed
// together come in one after another.
function startReveal(): void {
  document.documentElement.classList.add("js-ok");
  const io = new IntersectionObserver(function (entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  let last: Element | null = null;
  let n = 0;
  for (const el of all("[data-reveal]", HTMLElement)) {
    n = el.parentElement === last ? n + 1 : 0;
    last = el.parentElement;
    if (n > 0) el.style.setProperty("--d", `${Math.min(n, 6) * 70}ms`);
    io.observe(el);
  }
}

function startNav(): void {
  const nav = find("[data-nav]", HTMLElement);
  function update(): void { nav.classList.toggle("scrolled", scrollY > 8); }
  window.addEventListener("scroll", update, { passive: true });
  update();
}

function startCopy(): void {
  for (const button of all("[data-copy]", HTMLButtonElement)) {
    button.addEventListener("click", function () { void copy(button); });
  }
}

async function copy(button: HTMLButtonElement): Promise<void> {
  const label = button.querySelector("[data-copy-label]");
  let said = "copied ✓";
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.classList.add("copied");
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
    said = "press ⌘C";
  }
  if (label !== null) label.textContent = said;
  await sleep(1800);
  button.classList.remove("copied");
  if (label !== null) label.textContent = "copy";
}

// Each part starts on its own, so one that fails leaves the rest working.
const parts: [string, () => void][] = [
  ["reveal", startReveal],
  ["nav", startNav],
  ["copy", startCopy],
];

for (const [name, start] of parts) {
  try {
    start();
  } catch (e) {
    console.error(`soopdoop: ${name} did not start`, e);
  }
}
