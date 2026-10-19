// ABOUTME: Local dates and hours in a crew's time zone (an IANA name such as America/Toronto), with the Intl API and no
// ABOUTME: library: the hour and day for the digest, where a local day starts, the day before, and the month for the cost line.

export const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One formatter per time zone; making one is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  formatters.set(timeZone, made);
  return made;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  // 0 is Sunday.
  weekday: number;
}

function partsAt(at: number, timeZone: string): Parts {
  const out: Parts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const p of formatter(timeZone).formatToParts(at)) {
    if (p.type === "year") out.year = Number(p.value);
    else if (p.type === "month") out.month = Number(p.value);
    else if (p.type === "day") out.day = Number(p.value);
    // Some engines write midnight as 24 even in a 23-hour cycle.
    else if (p.type === "hour") out.hour = Number(p.value) % 24;
    else if (p.type === "minute") out.minute = Number(p.value);
    else if (p.type === "second") out.second = Number(p.value);
    else if (p.type === "weekday") out.weekday = Math.max(0, WEEKDAYS.indexOf(p.value));
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// The time zone's own spelling ("america/toronto" is America/Toronto), or null when it is not a time zone.
export function canonicalTimezone(timeZone: string): string | null {
  const name = timeZone.trim();
  if (name === "") return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// The local date (YYYY-MM-DD), hour (0 to 23) and weekday (0 is Sunday) at an instant.
export function localTime(at: number, timeZone: string): { day: string; hour: number; weekday: number } {
  const p = partsAt(at, timeZone);
  return { day: `${p.year}-${pad(p.month)}-${pad(p.day)}`, hour: p.hour, weekday: p.weekday };
}

function dayParts(day: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return { y: 1970, m: 1, d: 1 };
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// A calendar day `n` days after `day` (before, when n is negative). Calendar arithmetic: no time zone involved.
export function shiftDay(day: string, n: number): string {
  const { y, m, d } = dayParts(day);
  const at = new Date(Date.UTC(y, m - 1, d + n));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

// How far the zone's clock is ahead of UTC at an instant, in ms (negative west of Greenwich).
function offsetAt(at: number, timeZone: string): number {
  const p = partsAt(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

// The first instant of a local day. On a day the clocks change near midnight the offset at midnight differs from the
// one a few hours earlier, so both guesses are tried and the earliest one that is already on that day wins.
export function startOfDay(day: string, timeZone: string): number {
  const { y, m, d } = dayParts(day);
  const midnight = Date.UTC(y, m - 1, d);
  const first = midnight - offsetAt(midnight, timeZone);
  const second = midnight - offsetAt(first, timeZone);
  const onDay = [first, second]
    .filter(function (at) { return localTime(at, timeZone).day === day; })
    .sort(function (a, b) { return a - b; });
  return onDay[0] ?? first;
}

// A local day as a window [from, to) of instants. Usually 24 hours; 23 or 25 on the days the clocks change.
export function dayWindow(day: string, timeZone: string): { from: number; to: number } {
  return { from: startOfDay(day, timeZone), to: startOfDay(shiftDay(day, 1), timeZone) };
}

// The local month ("YYYY-MM") at an instant, and where it started.
export function localMonth(at: number, timeZone: string): { month: string; from: number } {
  const month = localTime(at, timeZone).day.slice(0, 7);
  return { month, from: startOfDay(`${month}-01`, timeZone) };
}
