// ABOUTME: Tiny DOM helpers: find an element or throw, build elements without innerHTML, replace children.
// ABOUTME: User-provided text always goes through text nodes, never HTML.

export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Missing #${id}`);
  return node;
}

export function input(id: string): HTMLInputElement {
  const node = byId(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return node;
}

export function select(id: string): HTMLSelectElement {
  const node = byId(id);
  if (!(node instanceof HTMLSelectElement)) throw new Error(`#${id} is not a select`);
  return node;
}

export type Child = Node | string | null | undefined | false;

// el("div", { class: "x", hidden: true }, "text", child). A `false` attribute is left out.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false) continue;
    if (key === "class") node.className = String(value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  append(node, ...children);
  return node;
}

export function append(host: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    host.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function replaceChildren(host: Element, ...children: Child[]): void {
  host.replaceChildren();
  append(host, ...children);
}

const SVG = "http://www.w3.org/2000/svg";

// The countdown ring from the prototype: a grey track, a coloured arc, and the seconds in the middle.
export function ring(circumference: number): { svg: SVGSVGElement; arc: SVGCircleElement; text: SVGTextElement } {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ring");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(SVG, "circle");
  track.setAttribute("class", "bg");
  const arc = document.createElementNS(SVG, "circle");
  arc.setAttribute("class", "fg");
  arc.setAttribute("stroke-dasharray", String(circumference));
  arc.setAttribute("stroke-dashoffset", "0");
  for (const c of [track, arc]) {
    c.setAttribute("cx", "14");
    c.setAttribute("cy", "14");
    c.setAttribute("r", "11");
  }
  const text = document.createElementNS(SVG, "text");
  text.setAttribute("x", "14");
  text.setAttribute("y", "17.5");
  text.setAttribute("text-anchor", "middle");
  svg.append(track, arc, text);
  return { svg, arc, text };
}
