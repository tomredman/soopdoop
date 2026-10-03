// ABOUTME: Typed channels between the parts of the page: where the wordmark's eyes should look and what mood they are
// ABOUTME: in. A channel is a list of listeners; emit calls each in turn.

export interface Channel<T> {
  on(fn: (value: T) => void): void;
  emit(value: T): void;
}

export function channel<T>(): Channel<T> {
  const fns: ((value: T) => void)[] = [];
  return {
    on: function (fn) { fns.push(fn); },
    emit: function (value) { for (const fn of fns) fn(value); },
  };
}

export type Mood = "normal" | "relay";

// A point on screen (client coordinates) for the eyes to look at, or null to go back to following the pointer.
export const lookAt = channel<{ x: number; y: number } | null>();
export const mood = channel<Mood>();

export function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
