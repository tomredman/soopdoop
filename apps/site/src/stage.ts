// ABOUTME: The hero demo, on a loop: an agent in a terminal asks the Operator, a crewmate's agent answers in the HUD
// ABOUTME: (purple while it is read, +10 XP after), and a knock nobody opens self-destructs. Rests while off screen.

import { centerOf, lookAt, mood } from "./bus";
import { calm, find, make, sleep, svg, visibility } from "./dom";

type Led = "green" | "blue" | "purple" | "off";

const QUESTION = "How does checkout pick a coupon?";
const ANSWER = "Drops expired coupons, then picks the biggest discount. New kinds go in COUPON_KINDS.";

export function startStage(): void {
  const stage = find("[data-stage]", HTMLElement);
  const term = find("[data-term]", HTMLElement, stage);
  const wire = find("[data-wire]", HTMLElement, stage);
  const knockBox = find("[data-hud-knock]", HTMLElement, stage);
  const xp = find("[data-hud-xp]", HTMLElement, stage);
  const bar = find("[data-hud-bar]", HTMLElement, stage);
  const seen = visibility(stage, 0.2);

  // Waits, and keeps waiting while nobody can see the stage.
  async function beat(ms: number): Promise<void> {
    await sleep(ms);
    while (!seen.on || document.hidden) await sleep(300);
  }

  function crew(who: string, led: Led, state: string, relaying = false): void {
    const li = find(`[data-who="${who}"]`, HTMLElement, stage);
    li.classList.toggle("relaying", relaying);
    find(".led", HTMLElement, li).className = `led led-${led}`;
    find("[data-state]", HTMLElement, li).textContent = state;
  }

  function popXp(who: string, text: string): void {
    const li = find(`[data-who="${who}"]`, HTMLElement, stage);
    const pop = make("span", "float-xp", text);
    li.append(pop);
    setTimeout(function () { pop.remove(); }, 1700);
  }

  // Drops the oldest lines once the terminal is full, like a real one scrolling.
  function trim(keep: Element): void {
    while (term.scrollHeight > term.clientHeight + 4 && term.firstElementChild !== null && term.firstElementChild !== keep) {
      term.firstElementChild.remove();
    }
  }

  async function line(text: string, cls = "", speed = 0): Promise<HTMLElement> {
    const p = make("p", cls);
    term.append(p);
    if (speed === 0 || calm) {
      p.textContent = text;
      trim(p);
      return p;
    }
    const caret = make("span", "caret");
    for (let i = 1; i <= text.length; i++) {
      p.textContent = text.slice(0, i);
      p.append(caret);
      if (i % 12 === 0) trim(p);
      await sleep(speed + Math.random() * speed);
    }
    caret.remove();
    trim(p);
    return p;
  }

  // A line with a spinner in front, until stop() swaps in the final words.
  function spinner(p: HTMLElement, text: string): () => void {
    const frames = ["◐", "◓", "◑", "◒"];
    let i = 0;
    const timer = setInterval(function () {
      i = (i + 1) % frames.length;
      p.textContent = `  ⎿ ${frames[i] ?? "◐"} ${text}`;
    }, 120);
    return function () { clearInterval(timer); };
  }

  function relay(): { el: HTMLElement; set(state: "routing" | "reading" | "answered"): void } {
    const el = make("div", "relay reading");
    const q = make("p", "relay-q");
    const led = make("i", "led led-purple");
    q.append(led, document.createTextNode(QUESTION));
    const a = make("p", "relay-a", "Finding the agent that knows…");
    const f = make("p", "relay-f", "the Operator · routing");
    el.append(q, a, f);
    wire.prepend(el);
    while (wire.children.length > 2) wire.lastElementChild?.remove();
    return {
      el,
      set: function (state) {
        if (state === "reading") {
          a.textContent = "Reading @mira’s agent…";
          f.textContent = "@mira · checkout";
        } else if (state === "answered") {
          el.className = "relay answered";
          led.className = "led led-green";
          a.textContent = ANSWER;
          f.textContent = "from @mira’s checkout · read 14k tokens";
        }
      },
    };
  }

  function setXp(value: number, progress: number): void {
    xp.textContent = String(value);
    bar.style.setProperty("--p", String(progress));
  }

  async function knock(): Promise<void> {
    const ring = svg("svg", { class: "ring", viewBox: "0 0 36 36" });
    const fg = svg("circle", { class: "ring-fg", cx: "18", cy: "18", r: "15" });
    ring.append(svg("circle", { cx: "18", cy: "18", r: "15" }), fg);
    const num = make("span", "k-num", "30");
    const ringBox = make("span", "k-ring");
    ringBox.append(ring, num);

    const top = make("div", "k-top");
    const from = make("span");
    from.append(make("b", "", "@zed"), document.createTextNode(" wants you to see this"));
    top.append(from, ringBox);
    const item = make("div", "k-item");
    item.append(make("span", "k-kind", "LINK"), make("span", "k-title", "the new menu page · PR #42"), make("span", "k-note", "“the tacos look bigger now”"));
    const btns = make("div", "k-btns");
    btns.append(make("span", "k-show", "Show me"), make("span", "", "Not now"));

    knockBox.className = "hud-knock";
    knockBox.replaceChildren(top, item, btns);
    knockBox.hidden = false;
    lookAt.emit(centerOf(knockBox));

    // Thirty seconds of fuse, shown fast.
    const total = calm ? 600 : 5200;
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / total);
      const left = Math.ceil(30 * (1 - t));
      num.textContent = String(left);
      fg.style.strokeDashoffset = (94.25 * t).toFixed(2);
      ring.classList.toggle("low", left <= 10);
      if (t >= 1) break;
      await sleep(80);
    }
    lookAt.emit(centerOf(knockBox));
    await scramble([from, item]);
    knockBox.classList.add("boom");
    await sleep(760);
    knockBox.hidden = true;
    knockBox.classList.remove("boom");
    lookAt.emit(null);
  }

  async function story(): Promise<void> {
    term.replaceChildren();
    wire.replaceChildren();
    setXp(127, 0.27);
    crew("mira", "blue", "idle · 2 agents");
    crew("zed", "green", "3 agents");
    crew("juno", "off", "offline");
    await beat(500);
    await line("~/tacocat ❯ claude", "t-dim", 24);
    await beat(250);
    await line("✻ Welcome back, @you.", "t-dim");
    await beat(500);
    await line("> add a “free guac” coupon type", "t-user", 38);
    await beat(700);
    await line("⏺ Before I read 40 files, let me ask the crew.", "", 9);
    await beat(350);
    await line(`⏺ soopdoop · ask_operator(“${QUESTION}”)`, "t-tool", 7);
    const r = relay();
    setXp(128, 0.28);
    const spin = await line("  ⎿ ◐ the Operator is finding the agent that knows…", "t-purple");
    let stop = spinner(spin, "the Operator is finding the agent that knows…");
    await beat(1300);
    stop();
    r.set("reading");
    crew("mira", "purple", "the Operator is reading…", true);
    mood.emit("relay");
    stop = spinner(spin, "the Operator is reading @mira’s agent…");
    await beat(2300);
    stop();
    spin.textContent = "  ⎿ the Operator read @mira’s agent once, and forgot it";
    r.set("answered");
    crew("mira", "green", "working · +10 XP");
    mood.emit("normal");
    popXp("mira", "+10 XP");
    await line(`  ⎿ src/checkout/coupons.ts: ${ANSWER.charAt(0).toLowerCase()}${ANSWER.slice(1)}`, "t-green", 4);
    await beat(800);
    await line("⏺ Got it from @mira’s agent. Skipping the 40 files.", "", 9);
    await line("⏺ Adding “free guac” to COUPON_KINDS…", "", 9);
    await beat(1400);
    crew("zed", "green", "knocked you");
    await knock();
    crew("zed", "green", "3 agents");
    await line("  (that knock self-destructed. no inbox. no guilt.)", "t-dim");
    await beat(2600);
  }

  async function loop(): Promise<void> {
    await beat(300);
    for (;;) {
      try {
        await story();
      } catch (e) {
        console.error("soopdoop: the demo stopped", e);
        return;
      }
    }
  }
  void loop();
}

// Turns the text of each element into noise for a moment, the way a self-destructing message should.
export async function scramble(els: HTMLElement[]): Promise<void> {
  if (calm) return;
  const glyphs = "▓▒░#%&*+=<>/\\|";
  const nodes: { node: Text; text: string }[] = [];
  for (const el of els) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n instanceof Text) nodes.push({ node: n, text: n.data });
    }
  }
  for (let f = 0; f < 9; f++) {
    for (const { node, text } of nodes) {
      node.data = Array.from(text, function (c) {
        return c === " " || Math.random() > (f + 1) / 9 ? c : glyphs.charAt(Math.floor(Math.random() * glyphs.length));
      }).join("");
    }
    await sleep(45);
  }
}
