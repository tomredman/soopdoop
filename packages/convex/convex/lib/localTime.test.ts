// ABOUTME: Tests for local dates and hours in a time zone: the day, hour and weekday, day starts across clock changes,
// ABOUTME: calendar arithmetic and the month. Runs on Bun's own time zone data.
import { describe, expect, test } from "bun:test";
import { canonicalTimezone, dayWindow, localMonth, localTime, shiftDay, startOfDay } from "./localTime";

const HOUR = 60 * 60 * 1000;

describe("local time in a crew's time zone", function () {
  test("reads the local day, hour and weekday", function () {
    // 13:30 UTC on Sunday 18 Oct 2026 is 9:30 in Toronto (summer time, UTC-4) and 22:30 in Tokyo (UTC+9).
    const at = Date.UTC(2026, 9, 18, 13, 30);
    expect(localTime(at, "America/Toronto")).toEqual({ day: "2026-10-18", hour: 9, weekday: 0 });
    expect(localTime(at, "Asia/Tokyo")).toEqual({ day: "2026-10-18", hour: 22, weekday: 0 });
    // Two hours later it is already Monday in Tokyo.
    expect(localTime(at + 2 * HOUR, "Asia/Tokyo")).toEqual({ day: "2026-10-19", hour: 0, weekday: 1 });
    expect(localTime(at, "UTC")).toEqual({ day: "2026-10-18", hour: 13, weekday: 0 });
  });

  test("knows time zones by their IANA names, in any case", function () {
    expect(canonicalTimezone("America/Toronto")).toBe("America/Toronto");
    expect(canonicalTimezone(" america/toronto ")).toBe("America/Toronto");
    expect(canonicalTimezone("UTC")).toBe("UTC");
    expect(canonicalTimezone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalTimezone("")).toBeNull();
  });

  test("moves calendar days across months, years and leap days", function () {
    expect(shiftDay("2026-10-18", -1)).toBe("2026-10-17");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-10-19", -7)).toBe("2026-10-12");
  });

  test("finds where a local day starts, east and west of Greenwich", function () {
    expect(startOfDay("2026-10-18", "America/Toronto")).toBe(Date.UTC(2026, 9, 18, 4));
    expect(startOfDay("2026-10-18", "Asia/Tokyo")).toBe(Date.UTC(2026, 9, 17, 15));
    expect(startOfDay("2026-10-18", "UTC")).toBe(Date.UTC(2026, 9, 18));
    expect(startOfDay("2026-10-18", "Asia/Kolkata")).toBe(Date.UTC(2026, 9, 17, 18, 30));
  });

  test("a day is 23 or 25 hours long when the clocks change", function () {
    // Toronto: summer time starts on 8 Mar 2026 and ends on 1 Nov 2026.
    const spring = dayWindow("2026-03-08", "America/Toronto");
    expect(spring.from).toBe(Date.UTC(2026, 2, 8, 5));
    expect(spring.to - spring.from).toBe(23 * HOUR);
    const fall = dayWindow("2026-11-01", "America/Toronto");
    expect(fall.from).toBe(Date.UTC(2026, 10, 1, 4));
    expect(fall.to - fall.from).toBe(25 * HOUR);
    const plain = dayWindow("2026-10-18", "Europe/Paris");
    expect(plain.to - plain.from).toBe(24 * HOUR);
  });

  test("the start of a day is its first instant, even where the clocks change at midnight", function () {
    const cases: [string, string][] = [
      ["America/Toronto", "2026-03-08"],
      ["America/Toronto", "2026-11-01"],
      ["Europe/London", "2026-03-29"],
      ["Australia/Sydney", "2026-10-04"],
      // Chile moves its clocks at midnight: some days start at 01:00.
      ["America/Santiago", "2026-09-06"],
      ["America/Santiago", "2026-04-05"],
      ["Asia/Tokyo", "2026-01-01"],
    ];
    for (const [zone, day] of cases) {
      const start = startOfDay(day, zone);
      expect([zone, localTime(start, zone).day]).toEqual([zone, day]);
      expect([zone, localTime(start - 1, zone).day]).toEqual([zone, shiftDay(day, -1)]);
    }
  });

  test("the month for the cost line is the crew's", function () {
    // 2:00 UTC on 1 Nov is still October in Toronto.
    const at = Date.UTC(2026, 10, 1, 2);
    expect(localMonth(at, "America/Toronto")).toEqual({ month: "2026-10", from: Date.UTC(2026, 9, 1, 4) });
    expect(localMonth(at, "UTC")).toEqual({ month: "2026-11", from: Date.UTC(2026, 10, 1) });
  });
});
