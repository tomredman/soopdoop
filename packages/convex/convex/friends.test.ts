import { describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import { hackerNamed, harness, must } from "./testing.helpers";

describe("friends", function () {
  test("a request waits for acceptance, then both sides list each other", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await expect(tom.mutation(api.friends.request, { handle: "nobody" })).rejects.toThrow("No hacker");
    await expect(tom.mutation(api.friends.request, { handle: "tom" })).rejects.toThrow("That is you");

    await tom.mutation(api.friends.request, { handle: "MIRA" });
    expect(await tom.query(api.friends.list, {})).toEqual([]);
    const pending = await mira.query(api.friends.pending, {});
    expect(pending.map((p) => p.handle)).toEqual(["tom"]);
    // Asking twice does not make two requests.
    await tom.mutation(api.friends.request, { handle: "mira" });
    expect(await mira.query(api.friends.pending, {})).toHaveLength(1);

    await mira.mutation(api.friends.accept, { friendshipId: must(pending[0]).friendshipId });
    expect((await tom.query(api.friends.list, {})).map((f) => f.handle)).toEqual(["mira"]);
    expect((await mira.query(api.friends.list, {})).map((f) => f.handle)).toEqual(["tom"]);
    expect(await mira.query(api.friends.pending, {})).toEqual([]);
  });

  test("a request back the other way counts as accepting", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await tom.mutation(api.friends.request, { handle: "mira" });
    await mira.mutation(api.friends.request, { handle: "tom" });
    expect((await tom.query(api.friends.list, {})).map((f) => f.handle)).toEqual(["mira"]);
  });

  test("only the receiver can accept", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    const dev = await hackerNamed(t, "dev");
    await tom.mutation(api.friends.request, { handle: "mira" });
    const pending = await mira.query(api.friends.pending, {});
    await expect(dev.mutation(api.friends.accept, { friendshipId: must(pending[0]).friendshipId })).rejects.toThrow("No such request");
  });

  test("an invite link works once, not for its maker, and not after 7 days", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    const dev = await hackerNamed(t, "dev");
    const token = await tom.mutation(api.friends.createInvite, {});
    await expect(tom.mutation(api.friends.redeemInvite, { token })).rejects.toThrow("your own invite");
    expect(await mira.mutation(api.friends.redeemInvite, { token })).toBe("tom");
    expect((await mira.query(api.friends.list, {})).map((f) => f.handle)).toEqual(["tom"]);
    await expect(dev.mutation(api.friends.redeemInvite, { token })).rejects.toThrow("no longer valid");
    await expect(dev.mutation(api.friends.redeemInvite, { token: "nope" })).rejects.toThrow("no longer valid");

    const old = await tom.mutation(api.friends.createInvite, {});
    await t.run(async function (ctx) {
      const invite = must(
        await ctx.db
          .query("invites")
          .withIndex("by_token", (q) => q.eq("token", old))
          .unique(),
      );
      await ctx.db.patch(invite._id, { expiresAt: Date.now() - 1 });
    });
    await expect(dev.mutation(api.friends.redeemInvite, { token: old })).rejects.toThrow("no longer valid");
  });
});
