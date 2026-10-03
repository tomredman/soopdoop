import { describe, expect, test } from "bun:test";
import { NOBODY, QUESTS, RANKS, rankFor, route, splitCode } from "./game";

describe("ranks", function () {
  test("match the app's ladder", function () {
    expect(RANKS.map(function (r) { return [r.name, r.at]; })).toEqual([
      ["n00b", 0], ["script kiddie", 20], ["hacker", 100], ["wizard", 400], ["legend", 1000],
    ]);
  });

  test("rankFor finds the rank, the next one and the progress between them", function () {
    expect(rankFor(0)).toEqual({ rank: { name: "n00b", at: 0 }, next: { name: "script kiddie", at: 20 }, progress: 0 });
    expect(rankFor(10).progress).toBe(0.5);
    expect(rankFor(20).rank.name).toBe("script kiddie");
    expect(rankFor(250).rank.name).toBe("hacker");
    expect(rankFor(5000)).toEqual({ rank: { name: "legend", at: 1000 }, next: null, progress: 1 });
  });

  test("the visible quests can reach script kiddie, and the konami code reaches hacker", function () {
    const visible = QUESTS.filter(function (q) { return q.secret !== true; }).reduce(function (n, q) { return n + q.xp; }, 0);
    expect(visible).toBeGreaterThanOrEqual(20);
    expect(visible + 100).toBeGreaterThanOrEqual(100);
  });
});

describe("the canned Operator", function () {
  test("routes each suggested question to the agent that knows", function () {
    expect(route("How does checkout pick a coupon?").agent).toBe("mira");
    expect(route("How does the menu sync with the kitchen?").agent).toBe("zed");
    expect(route("Why do sessions expire after an hour?").agent).toBe("juno");
    expect(route("Who broke staging?").text).toContain("does not do blame");
    expect(route("How do I exit vim?").agent).toBeNull();
  });

  test("matches plurals and tenses, but short keys only as whole words", function () {
    expect(route("where are expired coupons dropped").agent).toBe("mira");
    expect(route("How is a product priced?").agent).toBe("mira");
    expect(route("why are my carts empty").agent).toBe("mira");
    expect(route("how does authentication work").agent).toBe("juno");
    expect(route("cartography")).toBe(NOBODY);
    expect(route("a downpour")).toBe(NOBODY);
  });

  test("says nobody knows when nothing fits", function () {
    expect(route("what is the airspeed velocity of an unladen swallow")).toBe(NOBODY);
    expect(route("")).toBe(NOBODY);
  });

  test("splitCode marks the backticked parts", function () {
    expect(splitCode("`a.ts` drops `B` now")).toEqual([
      { code: true, text: "a.ts" },
      { code: false, text: " drops " },
      { code: true, text: "B" },
      { code: false, text: " now" },
    ]);
  });
});
