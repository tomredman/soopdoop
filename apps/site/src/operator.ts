// ABOUTME: The canned Operator on the page: a question pulses to the Operator, on to the crewmate's agent that knows
// ABOUTME: (purple while it "reads"), and back as a one-line answer with its receipt. Answers come from game.ts.

import { mood } from "./bus";
import { all, calm, find, make, sleep, svg } from "./dom";
import { route, splitCode, type Answer } from "./game";
import { award } from "./xp";

export function startOperator(): void {
  const form = find("[data-ask]", HTMLFormElement);
  const input = find("#op-q", HTMLInputElement);
  const button = find("button", HTMLButtonElement, form);
  const out = find("[data-out]", HTMLElement);
  const map = find("[data-map]", SVGSVGElement);
  const opNode = find('[data-node="op"]', SVGGElement, map);
  const opStatus = find("[data-op-status]", SVGTextElement, map);
  let busy = false;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    void ask(input.value);
  });
  for (const chip of all("[data-chips] button", HTMLButtonElement)) {
    chip.addEventListener("click", function () {
      input.value = chip.textContent ?? "";
      void ask(input.value);
    });
  }

  function path(name: string): SVGPathElement {
    return find(`[data-path="${name}"]`, SVGPathElement, map);
  }

  // A glowing dot that runs along a path, there or back.
  function pulse(along: SVGPathElement, back: boolean, color: string, ms: number): Promise<void> {
    if (calm) return Promise.resolve();
    return new Promise(function (resolve) {
      const dot = svg("circle", { r: "6", class: `m-pulse ${color}` });
      map.append(dot);
      const length = along.getTotalLength();
      const start = performance.now();
      function step(now: number): void {
        const t = Math.min(1, (now - start) / ms);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const p = along.getPointAtLength((back ? 1 - eased : eased) * length);
        dot.setAttribute("cx", p.x.toFixed(1));
        dot.setAttribute("cy", p.y.toFixed(1));
        if (t < 1) requestAnimationFrame(step);
        else {
          dot.remove();
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  function status(text: string, kind: "busy" | "done" | "none"): HTMLElement {
    const p = make("p", kind === "busy" ? "ans-status" : `ans-status ${kind}`);
    p.append(make("i", kind === "busy" ? "led led-purple" : kind === "done" ? "led led-green" : "led led-off"), document.createTextNode(text));
    return p;
  }

  async function ask(raw: string): Promise<void> {
    const question = raw.trim();
    if (question === "" || busy) return;
    busy = true;
    button.disabled = true;
    const answer = route(question);
    award("ask");

    const shown = status("Finding the agent that knows…", "busy");
    out.replaceChildren(make("p", "ans-q", `“${question}”`), shown);
    opNode.classList.add("busy");
    opStatus.textContent = "routing…";
    const you = path("you");
    you.classList.add("hot");
    await pulse(you, false, "blue", 650);
    await sleep(calm ? 0 : 500);

    if (answer.agent === null) {
      opStatus.textContent = "no match";
      shown.replaceWith(status("No agent read. Nothing to forget.", "none"));
    } else {
      const agent = find(`[data-node="${answer.agent}"]`, SVGGElement, map);
      const led = find(".m-led", SVGCircleElement, agent);
      const ledBefore = led.getAttribute("class") ?? "m-led led-green";
      const to = path(answer.agent);
      opStatus.textContent = "reading…";
      to.classList.add("hot");
      agent.classList.add("reading");
      led.setAttribute("class", "m-led led-purple");
      mood.emit("relay");
      const reading = status(`Reading @${answer.agent}’s agent…`, "busy");
      shown.replaceWith(reading);
      await pulse(to, false, "purple", 750);
      await sleep(calm ? 0 : 1100);
      to.classList.remove("hot");
      to.classList.add("done");
      agent.classList.remove("reading");
      agent.classList.add("answered");
      led.setAttribute("class", ledBefore);
      mood.emit("normal");
      await pulse(to, true, "green", 650);
      await pulse(you, true, "green", 550);
      reading.replaceWith(status(`Answered · from ${answer.from}`, "done"));
      setTimeout(function () {
        to.classList.remove("done");
        agent.classList.remove("answered");
      }, 2200);
    }
    you.classList.remove("hot");
    opNode.classList.remove("busy");
    opStatus.textContent = "idle";

    await show(answer);
    busy = false;
    button.disabled = false;
  }

  async function show(answer: Answer): Promise<void> {
    const text = make("p", "ans-text");
    out.append(text);
    const plain = splitCode(answer.text).map(function (p) { return p.text; }).join("");
    await decode(text, plain);
    text.replaceChildren(...splitCode(answer.text).map(function (p) {
      return p.code ? make("code", "", p.text) : document.createTextNode(p.text);
    }));
    const receipt = answer.tokens > 0
      ? `read ${(answer.tokens / 1000).toFixed(1)}k tokens · sent 1 line back · slice forgotten ✓`
      : "read nothing · answered from the Operator’s own head";
    out.append(make("p", "ans-receipt", receipt));
  }
}

// Types the answer in, with a band of noise running ahead of the letters.
async function decode(el: HTMLElement, text: string): Promise<void> {
  if (calm) {
    el.textContent = text;
    return;
  }
  const glyphs = "▓▒░<>/\\|=+*#%&";
  const frames = 28;
  for (let f = 0; f <= frames; f++) {
    const shown = Math.floor((text.length * f) / frames);
    let s = text.slice(0, shown);
    for (let i = shown; i < Math.min(text.length, shown + 12); i++) {
      s += text.charAt(i) === " " ? " " : glyphs.charAt(Math.floor(Math.random() * glyphs.length));
    }
    el.textContent = s;
    await sleep(24);
  }
  el.textContent = text;
}
