// ABOUTME: Tests for writing the digest: the headline, the plain digest, the weekly numbers, the 2,500-character cut, the
// ABOUTME: price, and the Opus 5.5 call against a stand-in for Anthropic's API (no real call is made).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  aboutTokens,
  clip,
  customerProps,
  type DigestMaterial,
  digestUsd,
  headline,
  isQuiet,
  MAX_DIGEST,
  plainDigest,
  shortName,
  weeklyText,
  withHeadline,
  writeDigest,
} from "./digest";

const NONE = { answered: 0, tokensSaved: 0, handoffs: 0, headsups: 0, ships: 0, walkthroughs: 0 };

function quietDay(): DigestMaterial {
  return { crew: "tom's crew", day: "2026-10-17", ships: [], walkthroughs: [], handoffs: [], headsups: [], props: [], saves: [], notes: [], shouts: [], work: [], numbers: NONE };
}

function busyDay(): DigestMaterial {
  return {
    ...quietDay(),
    ships: [{ who: "Ada", text: "the quote page redesign", url: "https://github.com/acme/web/pull/412", walkthrough: "https://soopdoop.com/d/abc" }],
    handoffs: [{ who: "Jimmy", forWho: "Tom", text: "VIB-123 fixed" }],
    headsups: [{ who: "Tom", other: "Jimmy" }],
    props: [
      { who: "Grace", text: "thanked for fixing their CSV export", fromCustomer: true },
      { who: "Ada", from: "Tom", text: "the quote page redesign", fromCustomer: false },
    ],
    saves: [{ who: "Grace", text: "a customer went from upset to thanks" }],
    notes: [{ who: "Ada", text: "the quote page uses the M10 components" }],
    shouts: [{ who: "@sam", text: "CI is red, looking" }],
    work: [{ who: "Jimmy", did: "fixed delivery counts double-counting bounces" }],
    numbers: { answered: 41, tokensSaved: 1_234_567, handoffs: 1, headsups: 1, ships: 1, walkthroughs: 1 },
  };
}

let saved: { fake?: string; key?: string } = {};
beforeEach(function () {
  saved = { fake: process.env.OPERATOR_FAKE, key: process.env.ANTHROPIC_API_KEY };
});
afterEach(function () {
  if (saved.fake === undefined) delete process.env.OPERATOR_FAKE;
  else process.env.OPERATOR_FAKE = saved.fake;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

describe("the digest's text", function () {
  test("names are first names, or the handle when someone linked no name", function () {
    expect(shortName({ handle: "adalovelace", name: "Ada Lovelace" })).toBe("Ada");
    expect(shortName({ handle: "sam" })).toBe("@sam");
    expect(shortName({ handle: "sam", name: "  " })).toBe("@sam");
  });

  test("token counts are rounded for people", function () {
    expect(aboutTokens(950)).toBe("950");
    expect(aboutTokens(41_400)).toBe("41k");
    expect(aboutTokens(1_234_567)).toBe("1.2M");
    expect(aboutTokens(9_000_000)).toBe("9M");
  });

  test("the headline counts what happened, and only what is above zero", function () {
    expect(headline(busyDay())).toBe("Yesterday in tom's crew: 1 ship, 1 hand-off, 41 questions answered");
    expect(headline(quietDay())).toBe("Yesterday in tom's crew");
    expect(headline({ ...quietDay(), numbers: { ...NONE, ships: 3 } })).toBe("Yesterday in tom's crew: 3 ships");
  });

  test("a day with nothing in it is quiet", function () {
    expect(isQuiet(quietDay())).toBe(true);
    expect(isQuiet({ ...quietDay(), shouts: [{ who: "Tom", text: "lunch?" }] })).toBe(false);
    expect(isQuiet({ ...quietDay(), numbers: { ...NONE, answered: 2 } })).toBe(false);
    // Background work alone is not news.
    expect(isQuiet({ ...quietDay(), work: [{ who: "Ada", did: "tidied the tests" }] })).toBe(true);
  });

  test("the plain digest lists each thing in a fixed order, positive only", function () {
    expect(plainDigest(busyDay())).toBe([
      "Yesterday in tom's crew: 1 ship, 1 hand-off, 41 questions answered",
      "• Ada shipped: the quote page redesign (https://github.com/acme/web/pull/412) · walkthrough: https://soopdoop.com/d/abc",
      "• Jimmy's agent did Tom's hand-off: VIB-123 fixed",
      "• 41 questions answered by crewmates' agents, about 1.2M tokens saved",
      "• 1 heads-up acted on: Tom checked with Jimmy first",
      "• Grace got props from a customer: thanked for fixing their CSV export",
      "• Tom gave Ada props for: the quote page redesign",
      "• Grace may have just saved a customer: a customer went from upset to thanks",
      "• Ada added a crew note: the quote page uses the M10 components",
      "• @sam: CI is red, looking",
    ].join("\n"));
  });

  test("a digest is cut at a line break to 2,500 characters", function () {
    const long = Array.from({ length: 100 }, function (_, i) { return `• line ${i} ${"x".repeat(40)}`; }).join("\n");
    const cut = clip(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_DIGEST);
    expect(cut.endsWith("x")).toBe(true);
    expect(long.startsWith(cut)).toBe(true);
    expect(clip("y".repeat(3000)).length).toBe(MAX_DIGEST);
    const many = { ...busyDay(), shouts: Array.from({ length: 80 }, function () { return { who: "Tom", text: "z".repeat(100) }; }) };
    expect(plainDigest(many).length).toBeLessThanOrEqual(MAX_DIGEST);
  });

  test("the week's four numbers leave out what is zero, and say nothing when all are", function () {
    expect(weeklyText("tom's crew", { answered: 212, tokensSaved: 9_000_000, handoffs: 14, headsups: 3, ships: 27, walkthroughs: 9 })).toBe([
      "This week in tom's crew",
      "• 212 questions answered by crewmates' agents, about 9M tokens saved",
      "• 14 hand-offs done by the agent that knew the area",
      "• 3 heads-ups acted on: duplicate or clashing work caught early",
      "• 27 ships, 9 with walkthroughs",
    ].join("\n"));
    expect(weeklyText("tom's crew", { ...NONE, ships: 1 })).toBe("This week in tom's crew\n• 1 ship");
    expect(weeklyText("tom's crew", NONE)).toBeNull();
  });

  test("a customer's props line says whether it went to the crew, and what the customer said", function () {
    expect(customerProps("got props from a customer: thanks, fixed fast")).toEqual({ toCrew: false, words: "thanks, fixed fast" });
    expect(customerProps("the crew got props from a customer: lovely")).toEqual({ toCrew: true, words: "lovely" });
    expect(customerProps("the crew got props from a customer")).toEqual({ toCrew: true, words: undefined });
    expect(customerProps("thanked for fixing their CSV export")).toEqual({ toCrew: false, words: "thanked for fixing their CSV export" });
  });

  test("Claude's body goes under the headline, without a second headline", function () {
    expect(withHeadline("Yesterday in tom's crew: 1 ship", "Yesterday in tom's crew!\n• Ada shipped the quote page")).toBe("Yesterday in tom's crew: 1 ship\n• Ada shipped the quote page");
    expect(withHeadline("Yesterday in x", "• one\n• two")).toBe("Yesterday in x\n• one\n• two");
  });

  test("a call's price is Opus 5.5's: $4 in, $20 out, $0.20 cache reads, per million tokens", function () {
    expect(digestUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBe(4);
    expect(digestUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBe(20);
    expect(digestUsd({ input_tokens: 2_000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: null })).toBe(0.02);
  });
});

describe("writing the digest", function () {
  test("OPERATOR_FAKE=1 writes the plain digest, with no call and no cost", async function () {
    process.env.OPERATOR_FAKE = "1";
    const call = spyOn(globalThis, "fetch");
    expect(await writeDigest(busyDay())).toEqual({ text: plainDigest(busyDay()) });
    expect(call).not.toHaveBeenCalled();
  });

  test("without a Claude key the plain digest still goes out", async function () {
    delete process.env.OPERATOR_FAKE;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await writeDigest(busyDay())).toEqual({ text: plainDigest(busyDay()) });
  });

  test("with a key, Opus 5.5 writes the body under the headline, and the cost is kept", async function () {
    delete process.env.OPERATOR_FAKE;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const sent: { url: string; body: Record<string, unknown>; beta: string | null }[] = [];
    spyOn(globalThis, "fetch").mockImplementation(async function (input: string | URL | Request, init?: RequestInit) {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)), beta: headers.get("anthropic-beta") });
      return new Response(JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "• Ada shipped the quote page redesign, with a walkthrough.\n• Jimmy's agent did Tom's hand-off." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3_000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
    } as unknown as typeof fetch);
    const written = await writeDigest(busyDay());
    expect(written).toEqual({
      text: "Yesterday in tom's crew: 1 ship, 1 hand-off, 41 questions answered\n• Ada shipped the quote page redesign, with a walkthrough.\n• Jimmy's agent did Tom's hand-off.",
      usd: 0.02,
    });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toContain("/v1/messages");
    expect(request?.body.model).toBe("claude-opus-5-5");
    expect(request?.body.fallbacks).toBe("default");
    expect(request?.body.output_config).toEqual({ effort: "low" });
    expect(request?.beta).toContain("server-side-fallback-2026-07-01");
    expect(JSON.stringify(request?.body.messages)).toContain("the quote page redesign");
  });

  test("a declined or failed call falls back to the plain digest", async function () {
    delete process.env.OPERATOR_FAKE;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    spyOn(globalThis, "fetch").mockImplementation(async function () {
      return new Response(JSON.stringify({
        id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: "refusal", stop_sequence: null,
        usage: { input_tokens: 1_000, output_tokens: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    } as unknown as typeof fetch);
    expect(await writeDigest(busyDay())).toEqual({ text: plainDigest(busyDay()), usd: 0.004 });

    (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    spyOn(globalThis, "fetch").mockImplementation(async function () {
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }), { status: 400, headers: { "content-type": "application/json" } });
    } as unknown as typeof fetch);
    const warn = spyOn(console, "warn").mockImplementation(function () { return undefined; });
    expect(await writeDigest(busyDay())).toEqual({ text: plainDigest(busyDay()) });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
