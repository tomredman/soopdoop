// ABOUTME: Tests heads-ups on the Mac: reading routing summaries, the scoring threshold against made-up prompts that must and must
// ABOUTME: not fire, same-file collisions, past work from the ledger, once an hour per crewmate agent, the note's words, and speed.
import { describe, expect, test } from "bun:test";
import {
  headsUpNote, headsUpper, parseCrewLines, parseSummary, readPrompt, score, terms, THRESHOLD, type CrewLine, type HeadsUp,
} from "./headsups-local";
import { handoffPrompt } from "./handoffs-local";
import type { CrewAgent, CrewNow } from "./intro";

const NOW = Date.parse("2026-10-18T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function agent(key: string, handle: string, summary: string): CrewAgent {
  return { key, handle, status: "working", summary, since: NOW - DAY };
}

// The crew's running agents, as routing:crew returns them (folder and branch only when the owner shares folder names).
const CREW: CrewNow = {
  now: NOW,
  agents: [
    agent("k-jimmy", "jimmy", '"why are bounces double counted in the delivery metrics" · files: packages/email/src/metrics.ts, packages/email/src/bounces.ts, apps/web/metrics/page.tsx'),
    agent("k-ada", "adalovelace", 'vibes@quote-redesign · "move the quote page to the M10 components" · files: apps/web/quote/Form.tsx, apps/web/quote/Summary.tsx, docs/changelog/2026-10.md'),
    agent("k-grace", "grace", '"add a retry to the stripe webhook handler" · files: apps/api/billing/webhook.ts, apps/api/billing/retry.ts'),
    agent("k-sam", "sam", '"clean up the onboarding emails copy" · files: packages/email/templates/welcome.tsx, …/sam/notes/todo.md'),
  ],
};

// The crew's last two weeks, as ledger:crewRecent returns them.
const LEDGER: CrewLine[] = [
  { handle: "jimmy", did: "Fixed the CSV export dropping rows", areas: ["apps/web/export"], at: NOW - 4 * DAY, harness: "claude-code" },
  { handle: "grace", did: "Added SSO login with Okta", areas: ["apps/api/auth"], at: NOW - 8 * DAY, harness: "codex" },
  { handle: "sam", did: "Rewrote the Lob pricing table for postcards", areas: ["packages/pricing"], at: NOW - 3 * DAY, harness: "grok" },
];

function setup(crew: CrewNow | null = CREW, lines: CrewLine[] = LEDGER) {
  let clock = NOW;
  const h = headsUpper({ crew() { return crew; }, async readLedger() { return lines; }, clock() { return clock; } });
  return { h, tick(ms: number) { clock += ms; } };
}

function who(hits: HeadsUp[]): string[] {
  return hits.map(function (x) { return `${x.otherHandle}:${x.kind}:${x.live ? "live" : "past"}`; });
}

describe("reading what crewmates share", function () {
  test("a routing summary: folder and branch when shared, the last prompt, the files", function () {
    expect(parseSummary('vibes@main · "fix the bounces" · files: a/b.ts, …/x/y/z.ts')).toEqual({ workspace: "vibes@main", prompt: "fix the bounces", files: ["a/b.ts", "…/x/y/z.ts"] });
    expect(parseSummary('"a prompt · with a dot" · files: a.ts')).toEqual({ prompt: "a prompt · with a dot", files: ["a.ts"] });
    expect(parseSummary("files: a.ts, b.ts")).toEqual({ files: ["a.ts", "b.ts"] });
    expect(parseSummary("vibes@main")).toEqual({ workspace: "vibes@main", files: [] });
  });

  test("the ledger's lines, defensively", function () {
    expect(parseCrewLines([{ handle: "jimmy", did: "x", areas: ["a", 2], at: 1, harness: "codex" }, { handle: 1 }, "x"])).toEqual([
      { handle: "jimmy", did: "x", areas: ["a"], at: 1, harness: "codex" },
    ]);
    expect(parseCrewLines(null)).toBeNull();
  });

  test("words: four letters or more, common ones left out, plurals and endings folded", function () {
    expect([...terms("The bounces got counted twice in deliveries, retries failing")]).toEqual(["bounce", "count", "twice", "delivery", "retry"]);
  });
});

describe("scoring a prompt", function () {
  const MUST = [
    // Mr. Tom's example from the plan.
    ["There's a bug: the email delivery metrics are wrong, bounces get counted twice. Can you fix it?", "jimmy:area:live"],
    ["Update apps/web/quote/Form.tsx so the submit button is disabled while saving", "adalovelace:area:live"],
    ["the stripe webhook fails on retries, look into billing", "grace:area:live"],
    ["make the M10 quote form match the new design", "adalovelace:area:live"],
    ["the CSV export is dropping rows again", "jimmy:area:past"],
    ["add SAML next to the Okta SSO login", "grace:area:past"],
  ];
  const MUST_NOT = [
    "add a dark mode toggle to the settings screen",
    "write unit tests for the date helpers",
    "update the README with install steps",
    "why is the build failing on CI?",
    "rename the user model field from fullName to name",
    "the email signup form has a typo",
    "show the delivery date on the order page",
    "yes, go ahead",
    // Near past work, but not the same work.
    "add login rate limiting",
    "update pricing copy on the homepage",
    "export the logs to a file",
  ];

  for (const [prompt, expected] of MUST) {
    test(`fires: ${prompt}`, async function () {
      const { h } = setup();
      await h.refreshLedger();
      expect(who(h.check("s1", prompt ?? ""))).toEqual([expected ?? ""]);
    });
  }

  for (const prompt of MUST_NOT) {
    test(`stays quiet: ${prompt}`, async function () {
      const { h } = setup();
      await h.refreshLedger();
      expect(h.check("s1", prompt)).toEqual([]);
    });
  }

  test("one word or one folder in common is never enough", function () {
    const t = { handle: "x", otherAgentId: "k", live: true, words: terms("email"), parts: new Set(["email"]), paths: [], names: new Set<string>(), files: [], areas: [], topic: "" };
    expect(score(readPrompt("the email"), t)).toBeLessThan(THRESHOLD);
  });
});

describe("heads-ups for a session", function () {
  test("a collision: this session and a crewmate's agent changing the same file, whatever the prompt", function () {
    const { h } = setup();
    h.ownSummary("s1", 'vibes@main · "polish the quote form" · files: apps/web/quote/Form.tsx, src/index.ts');
    const hits = h.check("s1", "run the linter");
    expect(who(hits)).toEqual(["adalovelace:files:live"]);
    expect(hits[0]?.files).toEqual(["apps/web/quote/Form.tsx"]);
    expect(hits[0]?.line).toBe("@adalovelace's agent is changing the same files right now: apps/web/quote/Form.tsx");
    // A generic file in common is not a collision.
    const other = setup();
    other.h.ownSummary("s2", '"x" · files: docs/changelog/README.md, package.json');
    expect(other.h.check("s2", "run the linter")).toEqual([]);
  });

  test("once an hour per crewmate agent and session; another session hears it too", function () {
    const { h, tick } = setup();
    const prompt = "the email delivery metrics count bounces twice";
    expect(h.check("s1", prompt)).toHaveLength(1);
    expect(h.check("s1", prompt)).toEqual([]);
    expect(h.check("s2", prompt)).toHaveLength(1);
    tick(61 * 60 * 1000);
    expect(h.check("s1", prompt)).toHaveLength(1);
    h.keepOnly(new Set(["s2"]));
    expect(h.check("s1", prompt)).toHaveLength(1);
  });

  test("past work only when no running agent is on it, the newest best line per crewmate", async function () {
    const { h } = setup(null, [...LEDGER, { handle: "jimmy", did: "Made the CSV export faster", areas: ["apps/web/export"], at: NOW - 1 * DAY, harness: "codex" }]);
    await h.refreshLedger();
    const hits = h.check("s1", "the CSV export is dropping rows again");
    expect(hits.map(function (x) { return x.line; })).toEqual(["@jimmy worked on this on 14 Oct (apps/web/export): Fixed the CSV export dropping rows"]);
  });

  test("a crewmate's hand-off arriving in this session makes no heads-up, though their agent's summary quotes the same task", function () {
    const task = "why are bounces double counted in the delivery metrics? Fix it in packages/email/src/metrics.ts";
    const { h } = setup();
    expect(who(h.check("s1", task))).toEqual(["jimmy:area:live"]);
    const receiving = setup();
    expect(receiving.h.check("s1", handoffPrompt("jimmy", task, "jd7abc"))).toEqual([]);
    // It does not use up the session's heads-up about that agent either.
    expect(who(receiving.h.check("s1", task))).toEqual(["jimmy:area:live"]);
  });

  test("the card's line comes from what the crewmate shares, never from the prompt", function () {
    const { h } = setup();
    const hits = h.check("s1", "secret plan: the email delivery metrics count bounces twice");
    expect(hits[0]?.line).toBe('@jimmy\'s agent is on this now (packages/email, apps/web/metrics): "why are bounces double counted in the delivery metrics"');
    expect(hits[0]?.areas).toEqual(["packages/email", "apps/web/metrics"]);
    expect(hits[0]?.line).not.toContain("secret plan");
  });

  test("nothing to score against: nothing, at once", function () {
    const { h } = setup({ now: NOW, agents: [] }, []);
    expect(h.check("s1", "the email delivery metrics count bounces twice")).toEqual([]);
  });

  test("scores a long prompt against a full crew in well under 5 ms", async function () {
    const many: CrewAgent[] = [];
    for (let i = 0; i < 20; i++) many.push(agent(`k${i}`, `mate${i}`, `"work on feature ${i} of the billing flow and the invoices" · files: apps/web/feature${i}/a.ts, apps/web/feature${i}/b.ts, packages/core${i}/c.ts`));
    const lines: CrewLine[] = [];
    for (let i = 0; i < 200; i++) lines.push({ handle: `mate${i % 20}`, did: `Changed module ${i} so the invoices total right`, areas: [`apps/web/module${i}`], at: NOW - (i % 14) * DAY, harness: "claude-code" });
    const { h } = setup({ now: NOW, agents: many }, lines);
    await h.refreshLedger();
    const prompt = "please look at the payment reconciliation job and the ledger export ".repeat(120).slice(0, 8_000);
    h.check("warm", prompt);
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      h.check(`s${i}`, prompt);
      times.push(performance.now() - started);
    }
    times.sort(function (a, b) { return a - b; });
    expect(times[Math.floor(times.length / 2)] ?? 99).toBeLessThan(5);
  });
});

describe("the note an agent reads", function () {
  test("names the crewmate, the area, and how to ask or hand off", function () {
    const live: HeadsUp = { otherHandle: "jimmy", otherAgentId: "k", kind: "area", line: "", live: true, areas: ["packages/email", "apps/web/metrics"], files: [] };
    expect(headsUpNote([live])).toBe(
      "soopdoop: @jimmy's agent is on this area now (packages/email, apps/web/metrics); ask it (ask_operator with @jimmy) or hand it off (hand_off with @jimmy) before you build.",
    );
    const files: HeadsUp = { ...live, otherHandle: "adalovelace", kind: "files", files: ["apps/web/quote/Form.tsx"] };
    expect(headsUpNote([files])).toBe(
      "soopdoop: @adalovelace's agent is changing the same files right now (apps/web/quote/Form.tsx); ask it (ask_operator with @adalovelace) or hand it off (hand_off with @adalovelace) before you build.",
    );
    const past: HeadsUp = { ...live, live: false, day: "15 Oct", areas: ["apps/web/export"] };
    expect(headsUpNote([past])).toBe(
      "soopdoop: @jimmy worked on this area on 15 Oct (apps/web/export) and their agent on it is not running; ask (ask_operator with @jimmy) or hand it off (hand_off with @jimmy) before you build.",
    );
    expect(headsUpNote([])).toBeNull();
  });
});
