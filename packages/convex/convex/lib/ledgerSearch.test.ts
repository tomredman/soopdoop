import { describe, expect, test } from "bun:test";
import { fitScore, search, terms } from "./ledgerSearch";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);

const lines = [
  { who: "adalovelace", did: "redesigned the quote page; new M09/M10 mocks", areas: ["apps/web/quote", "docs/changelog"], at: NOW - 1 * DAY, workspace: "vibes", branch: "quote-redesign" },
  { who: "jimmy", did: "fixed delivery counts double-counting bounces", areas: ["packages/email", "apps/web/metrics"], at: NOW - 2 * DAY, workspace: "vibes", branch: "email-metrics" },
  { who: "tom", did: "v0.13.1: Settings → Account box for the Superset handle", areas: ["apps/hud"], at: NOW - 2 * DAY },
];

function who(query: string): string[] {
  return search(query, lines, NOW).map(function (r) { return r.line.who; });
}

describe("searching the ledger", function () {
  test("words of four letters or more, without the ones every question has, and without a plural s", function () {
    expect([...terms("Who knows about the bounces in email metrics?")]).toEqual(["bounce", "email", "metric"]);
    expect([...terms("fix it")]).toEqual([]);
  });

  test("folders a line touched match the words of a question, and a folder written out matches best", function () {
    expect(who("who knows about email metrics?")).toEqual(["jimmy"]);
    expect(who("who changed apps/web/quote/Form.tsx?")).toEqual(["adalovelace"]);
    // A short word can be a folder.
    expect(who("who worked on the hud?")).toEqual(["tom"]);
    // Words of what was done.
    expect(who("anyone fix double counting of bounces?")).toEqual(["jimmy"]);
    // The branch counts too.
    expect(who("who is on quote-redesign")).toEqual(["adalovelace"]);
  });

  test("a question about nothing in the ledger finds nothing", function () {
    expect(who("who knows about that work?")).toEqual([]);
    expect(who("billing webhooks")).toEqual([]);
  });

  test("between equal matches, the newer line comes first, and a better match beats a newer one", function () {
    const two = [
      { did: "tuned the pricing table", areas: [], at: NOW - 20 * DAY },
      { did: "tuned the pricing table again", areas: [], at: NOW - 1 * DAY },
      { did: "pricing table and pricing plans", areas: ["apps/pricing"], at: NOW - 40 * DAY },
    ];
    const ranked = search("pricing table", two, NOW);
    expect(ranked.map(function (r) { return r.line.at; })).toEqual([NOW - 40 * DAY, NOW - 1 * DAY, NOW - 20 * DAY]);
    // The bonus never lifts a line past one more matching word.
    expect(must(ranked[1]).score - must(ranked[2]).score).toBeLessThan(1);
  });

  test("how well a task fits an agent's summary: the words they share", function () {
    const summary = "vibes@email-metrics · \"fix bounce counts\" · files: packages/email/send.ts";
    // bounce and metric; "files:" in a summary is not a word about the work.
    expect(fitScore("Fix the double-counted bounces in delivery metrics", summary)).toBe(2);
    expect(fitScore("Redesign the quote page and its files", summary)).toBe(0);
  });
});

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error("Expected a value");
  return x;
}
