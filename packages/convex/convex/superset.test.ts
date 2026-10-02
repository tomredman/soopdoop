import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { compactNumber, nameCheck, normalizeHandle, parseProfileMarkdown } from "./lib/supersetProfile";
import { befriend, harness, type Harness } from "./testing.helpers";

// A made-up profile in the exact shape Superset renders (apps/marketing/src/lib/profile-markdown.ts in its repo).
// The models table is deliberately not in token order.
function profilePage(o: { name?: string; handle?: string; tier?: string } = {}): string {
  const handle = o.handle ?? "ada-lovelace";
  return `---
title: "${o.name ?? "Ada Lovelace"} (@${handle})"
description: "Rank #12 of 2008 on the Superset leaderboard, tier 3."
---

# ${o.name ?? "Ada Lovelace"} (@${handle})

Rank #12 of 2008 on the Superset leaderboard, tier 3.

## Standing

- Rank: #12 of 2008
- Tier: ${o.tier ?? "Plant Manager"}
- Tokens: 9.20B all time
- Cost: $9000.00 API-equivalent
- Sessions: 800

## How this tier was reached

| Axis | Current | Needed | Met | Measures |
| --- | --- | --- | --- | --- |
| width | 2.0 | 6.2 | no | agents running at once |

## Achievements

- **ship-it** (level 2 of 4) at 10, earned 2026-09-07
- **night-owl**, earned 2026-09-08
- legacy-award

## Milestones

- tokens: 1.00B

## Models

| Provider | Model | Tokens | Cost |
| --- | --- | --- | --- |
| claude | claude-sonnet-5 | 900.0M | $300.00 |
| codex | gpt-5.6-sol | 4.10B | $3000.00 |
| codex | unknown | 2.00B | $10.00 |
| claude | claude-opus-5-5 | 3.20B | $5000.00 |
| claude | claude-haiku-4-5 | 1.5K | $0.01 |

## Token breakdown

- Output: 120.7M

Published voluntarily by the account holder. Source: https://superset.sh/${handle}`;
}

const NOT_FOUND = "# Not found\n\nThere is no document at this path on https://superset.sh.";

// Serves Superset's /md/user/<handle> pages from a map; anything else is a 404, as on the real site.
function fakeSuperset(pages: Record<string, string>): string[] {
  const asked: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async function (input: string | URL | Request) {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const handle = /^https:\/\/superset\.sh\/md\/user\/([^/]+)$/.exec(url)?.[1];
    const page = handle === undefined ? undefined : pages[handle];
    return page === undefined ? new Response(NOT_FOUND, { status: 404 }) : new Response(page, { status: 200 });
  } as unknown as typeof fetch);
  return asked;
}

// A signed-in hacker whose Superset sign-in carries a name, as Superset's ID tokens do.
async function hackerCalled(t: Harness, handle: string, name: string | undefined) {
  const identity = { subject: `superset|${handle}`, issuer: "https://api.superset.sh", ...(name === undefined ? {} : { name }) };
  const as = t.withIdentity(identity);
  await as.mutation(api.hackers.claimHandle, { handle });
  return as;
}

afterEach(function () {
  // Puts back the real fetch after every test that faked it.
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

describe("reading a Superset profile page", function () {
  test("keeps name, tier, achievements and model names, most tokens first", function () {
    expect(parseProfileMarkdown(profilePage())).toEqual({
      handle: "ada-lovelace",
      name: "Ada Lovelace",
      tier: "Plant Manager",
      achievements: [{ slug: "ship-it", level: 2, of: 4 }, { slug: "night-owl" }, { slug: "legacy-award" }],
      models: ["gpt-5.6-sol", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
    });
  });

  test("keeps no token counts, cost or rank", function () {
    const kept = JSON.stringify(parseProfileMarkdown(profilePage()));
    for (const leak of ["9.20B", "9000", "#12", "800", "Sessions", "Rank"]) expect(kept).not.toContain(leak);
  });

  test("a profile with no display name, no tier and no tables still reads", function () {
    const bare = "# ada (@ada)\n\n## Standing\n\n- Tier: Unranked\n";
    expect(parseProfileMarkdown(bare)).toEqual({ handle: "ada", achievements: [], models: [] });
  });

  test("anything that is not a profile page is null", function () {
    expect(parseProfileMarkdown(NOT_FOUND)).toBeNull();
    expect(parseProfileMarkdown("")).toBeNull();
  });

  test("reads counts the way Superset prints them", function () {
    expect(compactNumber("21.73B")).toBe(21.73e9);
    expect(compactNumber("53.5M")).toBe(53.5e6);
    expect(compactNumber("1.0K")).toBe(1000);
    expect(compactNumber("740")).toBe(740);
    expect(compactNumber("lots")).toBe(0);
  });

  test("takes a handle, an @handle, or a pasted profile URL", function () {
    expect(normalizeHandle("jimmyvibes")).toBe("jimmyvibes");
    expect(normalizeHandle(" @JimmyVibes ")).toBe("jimmyvibes");
    expect(normalizeHandle("https://superset.sh/jimmyvibes")).toBe("jimmyvibes");
    expect(normalizeHandle("superset.sh/md/user/jimmyvibes/")).toBe("jimmyvibes");
    for (const bad of ["j", "jimmy_vibes", "-jimmy", "jimmy--vibes", "https://example.com/jimmyvibes", "a".repeat(40)]) {
      expect(normalizeHandle(bad)).toBeNull();
    }
  });

  test("the name check ignores case and spacing, and says when it cannot tell", function () {
    expect(nameCheck("Ada  Lovelace", "ada lovelace")).toBe("match");
    expect(nameCheck("Ada Lovelace", "Grace Hopper")).toBe("mismatch");
    expect(nameCheck(undefined, "Ada Lovelace")).toBe("unknown");
    expect(nameCheck("Ada Lovelace", undefined)).toBe("unknown");
    expect(nameCheck("Ada Lovelace", " ")).toBe("unknown");
  });
});

describe("linking a Superset profile", function () {
  test("a friend sees your name, tier, achievements and top three models", async function () {
    const t = harness();
    fakeSuperset({ "ada-lovelace": profilePage() });
    const ada = await hackerCalled(t, "ada", "Ada Lovelace");
    const tom = await hackerCalled(t, "tom", "Tom Redman");
    await befriend(ada, tom, "tom");

    expect(await ada.action(api.superset.linkProfile, { handle: "@Ada-Lovelace" })).toEqual({ handle: "ada-lovelace", name: "Ada Lovelace" });
    const [seen] = await tom.query(api.friends.list, {});
    expect(seen?.superset).toEqual({
      handle: "ada-lovelace",
      name: "Ada Lovelace",
      tier: "Plant Manager",
      achievements: [{ slug: "ship-it", level: 2, of: 4 }, { slug: "night-owl" }, { slug: "legacy-award" }],
      models: ["gpt-5.6-sol", "claude-opus-5-5", "claude-sonnet-5"],
    });
    expect((await ada.query(api.hackers.me, {}))?.superset?.handle).toBe("ada-lovelace");

    await ada.mutation(api.superset.unlinkProfile, {});
    expect((await tom.query(api.friends.list, {}))[0]?.superset).toBeUndefined();
    expect((await ada.query(api.hackers.me, {}))?.superset).toBeUndefined();
  });

  test("refuses someone else's profile, a missing one, and a bad handle", async function () {
    const t = harness();
    fakeSuperset({ "ada-lovelace": profilePage() });
    const grace = await hackerCalled(t, "grace", "Grace Hopper");
    await expect(grace.action(api.superset.linkProfile, { handle: "ada-lovelace" })).rejects.toThrow("Link your own profile");
    await expect(grace.action(api.superset.linkProfile, { handle: "grace-hopper" })).rejects.toThrow("no public profile for @grace-hopper");
    await expect(grace.action(api.superset.linkProfile, { handle: "grace_hopper" })).rejects.toThrow("A Superset handle is");
    expect((await grace.query(api.hackers.me, {}))?.superset).toBeUndefined();
  });

  test("links without a name to compare only when the hacker asks, not automatically", async function () {
    const t = harness();
    fakeSuperset({ ada: "# ada (@ada)\n" });
    const ada = await hackerCalled(t, "ada", "Ada Lovelace");
    await expect(ada.action(api.superset.linkProfile, { handle: "ada", auto: true })).rejects.toThrow("no name to compare");
    expect(await ada.action(api.superset.linkProfile, { handle: "ada" })).toEqual({ handle: "ada" });
  });

  test("one Superset profile links to one soopdoop hacker", async function () {
    const t = harness();
    fakeSuperset({ "ada-lovelace": profilePage() });
    const ada = await hackerCalled(t, "ada", "Ada Lovelace");
    const twin = await hackerCalled(t, "ada-two", "Ada Lovelace");
    await ada.action(api.superset.linkProfile, { handle: "ada-lovelace" });
    await expect(twin.action(api.superset.linkProfile, { handle: "ada-lovelace" })).rejects.toThrow("already linked");
  });

  test("you need a soopdoop handle and a sign-in", async function () {
    const t = harness();
    fakeSuperset({ "ada-lovelace": profilePage() });
    await expect(t.action(api.superset.linkProfile, { handle: "ada-lovelace" })).rejects.toThrow("Not signed in");
    const noHandle = t.withIdentity({ subject: "superset|nohandle", issuer: "https://api.superset.sh", name: "Ada Lovelace" });
    await expect(noHandle.action(api.superset.linkProfile, { handle: "ada-lovelace" })).rejects.toThrow("Pick a soopdoop handle first");
  });
});

describe("refreshing linked profiles", function () {
  test("picks up changes, keeps the copy when Superset fails, and drops it when the owner unpublishes", async function () {
    const t = harness();
    fakeSuperset({ "ada-lovelace": profilePage() });
    const ada = await hackerCalled(t, "ada", "Ada Lovelace");
    await ada.action(api.superset.linkProfile, { handle: "ada-lovelace" });

    fakeSuperset({ "ada-lovelace": profilePage({ tier: "Henry Ford" }) });
    await t.action(internal.superset.refreshAll, {});
    expect((await ada.query(api.hackers.me, {}))?.superset?.tier).toBe("Henry Ford");

    spyOn(globalThis, "fetch").mockImplementation(async function () {
      throw new Error("offline");
    } as unknown as typeof fetch);
    await t.action(internal.superset.refreshAll, {});
    expect((await ada.query(api.hackers.me, {}))?.superset?.tier).toBe("Henry Ford");

    fakeSuperset({});
    await t.action(internal.superset.refreshAll, {});
    expect((await ada.query(api.hackers.me, {}))?.superset).toBeUndefined();
  });
});
