import { describe, expect, test } from "bun:test";
import { countdown, initials, minutesLeft, ringOffset, secondsLeft } from "./format";

describe("format", function () {
  test("countdown rounds up and never goes negative", function () {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
    expect(countdown(30_000, 0)).toBe("30");
    expect(countdown(120_000, 0)).toBe("2:00");
    expect(countdown(120_000, 30_500)).toBe("1:30");
    expect(countdown(120_000, 61_000)).toBe("59");
  });

  test("ring offset goes from 0 to the full circumference", function () {
    expect(ringOffset(69.1, 30_000, 30_000, 0)).toBe(0);
    expect(ringOffset(69.1, 30_000, 30_000, 15_000)).toBeCloseTo(34.55);
    expect(ringOffset(69.1, 30_000, 30_000, 30_000)).toBe(69.1);
    expect(ringOffset(69.1, 30_000, 30_000, 99_000)).toBe(69.1);
  });

  test("minutes left and initials", function () {
    expect(minutesLeft(60_000 * 25, 1)).toBe(25);
    expect(minutesLeft(0, 1)).toBe(0);
    expect(initials("tom")).toBe("TO");
    expect(initials("tom-redman")).toBe("TR");
    expect(initials("x")).toBe("X");
  });
});

import { cleanError } from "./format";

describe("cleanError", function () {
  test("keeps only the message a function threw", function () {
    const raw = "[CONVEX M(knocks:send)] [Request ID: abc] Server Error\nUncaught Error: You can only knock on a friend.\n    at handler (../convex/knocks.ts:32:60)";
    expect(cleanError(new Error(raw))).toBe("You can only knock on a friend.");
    expect(cleanError(new Error("plain failure"))).toBe("plain failure");
    expect(cleanError("string")).toBe("string");
  });

  test("reads a ConvexError's message from its data, the only part production passes on", function () {
    const fromProduction = Object.assign(new Error("[CONVEX M(friends:request)] [Request ID: 99ad] Server Error\n  Called by client"), { data: "ain’t nobody with that handle" });
    expect(cleanError(fromProduction)).toBe("ain’t nobody with that handle");
    expect(cleanError(Object.assign(new Error("Server Error"), { data: { code: 1 } }))).toBe("Server Error");
  });
});
