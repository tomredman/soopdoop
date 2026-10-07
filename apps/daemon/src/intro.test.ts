import { describe, expect, test } from "bun:test";
import { agentLine, introducer, introduction, news, parseCrewNow, type CrewAgent } from "./intro";

function agent(key: string, handle: string, since: number, extra: Partial<CrewAgent> = {}): CrewAgent {
  return { key, handle, status: "working", summary: `"${handle}'s task" · files: src/${handle}.ts`, since, ...extra };
}

describe("introducing the crew's agents", function () {
  test("reads the crew defensively", function () {
    expect(parseCrewNow({ now: 5, agents: [{ key: "k", handle: "tom", status: "idle", summary: "s", since: 1, name: "Tom" }, { handle: "x" }, 3] }))
      .toEqual({ now: 5, agents: [{ key: "k", handle: "tom", status: "idle", summary: "s", since: 1, name: "Tom" }] });
    for (const bad of [null, [], { now: "5", agents: [] }, { now: 5 }]) expect(parseCrewNow(bad)).toBeNull();
  });

  test("one line per agent, with the crewmate's name when they linked one, cut when it is long", function () {
    expect(agentLine(agent("k", "tom", 1, { name: "Tom Redman", summary: "\"build MLS-based email cannonballs\"" })))
      .toBe("- @tom (Tom Redman), working: \"build MLS-based email cannonballs\"");
    expect(agentLine(agent("k", "vlad", 1, { status: "waiting" }))).toStartWith("- @vlad, idle: ");
    const long = agentLine(agent("k", "tom", 1, { summary: "x".repeat(500) }));
    expect(long.length).toBe(320);
    expect(long.endsWith("…")).toBe(true);
  });

  test("the introduction names the agents and how to ask them, and says nothing when there are none", function () {
    const text = introduction({ now: 10, agents: [agent("a", "tom", 1), agent("b", "vlad", 2)] }) ?? "";
    expect(text.split("\n")).toEqual([
      "soopdoop: your crewmates' agents running now, and what each one is working on.",
      "- @tom, working: \"tom's task\" · files: src/tom.ts",
      "- @vlad, working: \"vlad's task\" · files: src/vlad.ts",
      expect.stringContaining("call ask_operator with the crewmate's @handle in the question"),
    ]);
    expect(introduction({ now: 10, agents: [] })).toBeNull();
    const many = introduction({ now: 10, agents: Array.from({ length: 15 }, function (_, i) { return agent(`k${i}`, `h${i}`, 1); }) }) ?? "";
    expect(many).toContain("- @h11, working");
    expect(many).not.toContain("@h12,");
    expect(many).toContain("- and 3 more. ask_operator reaches them too.");
  });

  test("news is only the agents the crew heard of after the session was told", function () {
    const crew = { now: 30, agents: [agent("a", "tom", 5), agent("b", "jimmy", 25)] };
    expect(news(crew, 20)).toBe([
      "soopdoop: a crewmate's agent started since you last heard about your crew.",
      "- @jimmy, working: \"jimmy's task\" · files: src/jimmy.ts",
      "If your work touches theirs, ask that agent with ask_operator and the crewmate's @handle in the question.",
    ].join("\n"));
    expect(news(crew, 30)).toBeNull();
  });
});

describe("the introducer", function () {
  function setup(views: unknown[]) {
    let clock = 1_000;
    let reads = 0;
    const intro = introducer(async function () {
      const view = views[Math.min(reads, views.length - 1)];
      reads += 1;
      if (view instanceof Error) throw view;
      return view;
    }, { maxAgeMs: 30_000, waitMs: 200, clock: function () { return clock; } });
    return { intro, tick(ms: number) { clock += ms; }, reads: function () { return reads; } };
  }

  test("a new session gets the whole introduction, then only agents that start later, once", async function () {
    const first = { now: 100, agents: [agent("a", "tom", 50)] };
    const second = { now: 200, agents: [agent("a", "tom", 50), agent("b", "jimmy", 150)] };
    const { intro, tick } = setup([first, second]);

    expect(await intro.contextFor("SessionStart", "s1")).toContain("- @tom, working");
    // The next prompt: nothing new.
    expect(await intro.contextFor("UserPromptSubmit", "s1")).toBeNull();
    // Jimmy starts an agent; the copy is read again behind the prompts, so the one after hears about it.
    tick(31_000);
    expect(await intro.contextFor("UserPromptSubmit", "s1")).toBeNull();
    await Bun.sleep(0);
    const told = await intro.contextFor("UserPromptSubmit", "s1");
    expect(told).toContain("- @jimmy, working");
    expect(told).not.toContain("@tom");
    expect(await intro.contextFor("UserPromptSubmit", "s1")).toBeNull();
    // Other events say nothing.
    expect(await intro.contextFor("Stop", "s1")).toBeNull();
    expect(await intro.contextFor("PreToolUse", "s1")).toBeNull();
  });

  test("a session it has not seen start is introduced at its first prompt, and a cleared one again", async function () {
    const { intro, reads } = setup([{ now: 100, agents: [agent("a", "tom", 50)] }]);
    expect(await intro.contextFor("UserPromptSubmit", "s2")).toContain("@tom");
    expect(await intro.contextFor("UserPromptSubmit", "s2")).toBeNull();
    expect(await intro.contextFor("SessionStart", "s2")).toContain("@tom");
    // One read served all three: the copy was fresh.
    expect(reads()).toBe(1);
  });

  test("without a crew to read it says nothing, and tries again at the next prompt", async function () {
    const { intro } = setup([new Error("offline"), { now: 100, agents: [agent("a", "tom", 50)] }]);
    expect(await intro.contextFor("SessionStart", "s3")).toBeNull();
    expect(await intro.contextFor("UserPromptSubmit", "s3")).toContain("@tom");
  });

  test("a slow read does not hold a session's start past waitMs, and lands for the next prompt", async function () {
    let release: (v: unknown) => void = function () { /* set below */ };
    const intro = introducer(function () { return new Promise(function (resolve) { release = resolve; }); }, { waitMs: 50 });
    const started = Date.now();
    expect(await intro.contextFor("SessionStart", "s4")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    release({ now: 100, agents: [agent("a", "tom", 50)] });
    await Bun.sleep(0);
    expect(await intro.contextFor("UserPromptSubmit", "s4")).toContain("@tom");
  });

  test("forgets sessions that ended", async function () {
    const { intro } = setup([{ now: 100, agents: [agent("a", "tom", 50)] }]);
    expect(await intro.contextFor("SessionStart", "s5")).toContain("@tom");
    intro.keepOnly(new Set());
    // Forgotten: a prompt from it is a session it has not introduced.
    expect(await intro.contextFor("UserPromptSubmit", "s5")).toContain("@tom");
  });
});
