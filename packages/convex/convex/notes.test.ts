// ABOUTME: Tests for crew notes: adding, replacing, editing, confirming and retiring; the plan's cap; age nudges and
// ABOUTME: staleness; agents' proposals with owner approval and trusted posters; and what a daemon delivers.
import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_WAITING } from "./notes";
import { type Actor, crewIdOf, hackerNamed, harness, type Harness, idOf, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const DAY = 24 * 60 * 60 * 1000;

afterEach(async function () {
  await settleScheduled();
});

// Tom leads a crew with Ada and Jimmy in it.
async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  const jimmy = await hackerNamed(t, "jimmy");
  await invite(tom, ada);
  await invite(tom, jimmy);
  return { tom, ada, jimmy, crewId: await crewIdOf(t, "tom") };
}

async function daemonOf(as: Actor, machine: string): Promise<string> {
  return await as.mutation(api.subsets.pairDaemon, { machineName: machine });
}

async function age(t: Harness, noteId: Id<"notes">, days: number): Promise<void> {
  await t.run(async function (ctx) {
    await ctx.db.patch("notes", noteId, { createdAt: Date.now() - days * DAY, confirmedAt: undefined });
  });
}

describe("crew notes", function () {
  test("a person adds a live note, the wire hears about it, and the whole crew lists it", async function () {
    const t = harness();
    const { tom, ada } = await crew(t);
    const text = "The quote page uses the M10 components; do not touch the old Form.tsx. ".repeat(2).trim();
    const noteId = await ada.mutation(api.notes.add, { text, tags: ["Design", "#pricing", "design", " "], appliesWhen: " apps/web " });
    const listed = await tom.query(api.notes.list, {});
    expect(listed.live).toMatchObject([{
      _id: noteId,
      text,
      tags: ["design", "pricing"],
      authorHandle: "adalovelace",
      status: "live",
      proposedByAgent: false,
      appliesWhen: "apps/web",
      nudge: false,
      stale: false,
    }]);
    expect([listed.proposed, listed.retired]).toEqual([[], []]);
    const line = must((await tom.query(api.feed.recent, {})).find(function (e) { return e.kind === "note"; }));
    expect(line).toMatchObject({ handle: "adalovelace", noteId, text: text.slice(0, 120) });
  });

  test("notes belong to a crew, are checked, and lose anything that looks like a key", async function () {
    const t = harness();
    const { ada } = await crew(t);
    const sam = await hackerNamed(t, "sam");
    await expect(sam.mutation(api.notes.add, { text: "a note" })).rejects.toThrow("belong to a crew");
    expect(await sam.query(api.notes.list, {})).toEqual({ live: [], proposed: [], retired: [] });
    await expect(ada.mutation(api.notes.add, { text: "  " })).rejects.toThrow("Write the note");
    await expect(ada.mutation(api.notes.add, { text: "x".repeat(401) })).rejects.toThrow("under 400");
    await ada.mutation(api.notes.add, { text: "deploy with sk-ant-api03-AbCdEf0123456789xyz from the vault" });
    expect((await ada.query(api.notes.list, {})).live[0]?.text).toBe("deploy with [secret] from the vault");
  });

  test("a note can replace a live one, which retires it", async function () {
    const t = harness();
    const { tom, ada, jimmy } = await crew(t);
    const v2 = await ada.mutation(api.notes.add, { text: "design rules v2: 8px grid" });
    // Anyone in the crew can write the update.
    const v3 = await jimmy.mutation(api.notes.add, { text: "design rules v3: 4px grid", replaces: v2 });
    const listed = await tom.query(api.notes.list, {});
    expect(listed.live.map(function (n) { return n._id; })).toEqual([v3]);
    expect(listed.retired).toMatchObject([{ _id: v2, status: "retired" }]);
    expect(listed.live[0]?.replaces).toBe(v2);
    await expect(ada.mutation(api.notes.add, { text: "v4", replaces: v2 })).rejects.toThrow("not a live note");
  });

  test("its author or the leader edits, confirms and retires a note; nobody else", async function () {
    const t = harness();
    const { tom, ada, jimmy } = await crew(t);
    const noteId = await ada.mutation(api.notes.add, { text: "Lob prices changed on Tuesday", confirmBy: Date.now() + 30 * DAY, appliesWhen: "packages/print" });
    await expect(jimmy.mutation(api.notes.edit, { noteId, text: "nope" })).rejects.toThrow("author or the crew leader");
    await expect(jimmy.mutation(api.notes.confirm, { noteId })).rejects.toThrow("author or the crew leader");
    await expect(jimmy.mutation(api.notes.retire, { noteId })).rejects.toThrow("author or the crew leader");

    const before = must((await ada.query(api.notes.list, {})).live[0]);
    await Bun.sleep(5);
    await tom.mutation(api.notes.edit, { noteId, text: "Lob prices changed on Tuesday 14 Oct", tags: ["pricing"], confirmBy: null, appliesWhen: null });
    const edited = must((await ada.query(api.notes.list, {})).live[0]);
    expect(edited).toMatchObject({ text: "Lob prices changed on Tuesday 14 Oct", tags: ["pricing"] });
    expect([edited.confirmBy, edited.appliesWhen]).toEqual([undefined, undefined]);
    expect(edited.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(must(edited.confirmedAt)).toBeGreaterThan(before.createdAt);

    await ada.mutation(api.notes.retire, { noteId });
    expect((await ada.query(api.notes.list, {})).retired).toMatchObject([{ _id: noteId }]);
    await expect(ada.mutation(api.notes.edit, { noteId, text: "back" })).rejects.toThrow("retired");
    await expect(ada.mutation(api.notes.confirm, { noteId })).rejects.toThrow("live note");
    // Someone outside the crew cannot reach it at all.
    const sam = await hackerNamed(t, "sam");
    await expect(sam.mutation(api.notes.retire, { noteId })).rejects.toThrow("not in your crew");
  });

  test("the free plan keeps 10 live notes, the team plan 60", async function () {
    const t = harness();
    const { tom, crewId } = await crew(t);
    const ids: Id<"notes">[] = [];
    for (let i = 0; i < 10; i++) ids.push(await tom.mutation(api.notes.add, { text: `note ${i}` }));
    await expect(tom.mutation(api.notes.add, { text: "one too many" })).rejects.toThrow("10 live notes, the most on the free plan");
    // Replacing one keeps the count.
    await tom.mutation(api.notes.add, { text: "note 0, updated", replaces: must(ids[0]) });
    await teamPlan(t, crewId);
    await tom.mutation(api.notes.add, { text: "room on the team plan" });
    expect((await tom.query(api.notes.list, {})).live).toHaveLength(11);
  });

  test("a note asks to be confirmed at 30 days or after its confirm-by date, and stops being delivered at 45", async function () {
    const t = harness();
    const { ada } = await crew(t);
    const token = await daemonOf(ada, "am");
    const noteId = await ada.mutation(api.notes.add, { text: "Ada owns the quote page this week" });
    const dated = await ada.mutation(api.notes.add, { text: "the freeze ends Friday", confirmBy: Date.now() - 1000 });

    function find(list: Awaited<ReturnType<typeof listOf>>, id: Id<"notes">) {
      return must(list.live.find(function (n) { return n._id === id; }));
    }
    async function listOf() {
      return await ada.query(api.notes.list, {});
    }
    expect(find(await listOf(), noteId)).toMatchObject({ nudge: false, stale: false });
    expect(find(await listOf(), dated)).toMatchObject({ nudge: true, stale: false });

    await age(t, noteId, 31);
    expect(find(await listOf(), noteId)).toMatchObject({ nudge: true, stale: false });
    expect((await t.query(api.notes.forDaemon, { token })).notes.map(function (n) { return n.id; })).toContain(noteId);

    await age(t, noteId, 46);
    expect(find(await listOf(), noteId)).toMatchObject({ nudge: true, stale: true });
    expect((await t.query(api.notes.forDaemon, { token })).notes.map(function (n) { return n.id; })).not.toContain(noteId);

    // "Still true": the age starts again, and it is delivered again.
    await ada.mutation(api.notes.confirm, { noteId });
    await ada.mutation(api.notes.confirm, { noteId: dated });
    expect(find(await listOf(), noteId)).toMatchObject({ nudge: false, stale: false });
    expect(find(await listOf(), dated)).toMatchObject({ nudge: false });
    expect((await t.query(api.notes.forDaemon, { token })).notes.map(function (n) { return n.id; })).toContain(noteId);
  });

  test("an agent proposes a note; its owner or the leader approves or rejects it", async function () {
    const t = harness();
    const { tom, ada, jimmy } = await crew(t);
    const token = await daemonOf(ada, "am");
    const proposed = await t.mutation(api.notes.propose, { token, text: "run bun test before pushing", tags: ["process"] });
    expect(proposed.status).toBe("proposed");
    // The same text again is the same note.
    expect(await t.mutation(api.notes.propose, { token, text: "Run bun test before pushing" })).toEqual(proposed);

    expect((await ada.query(api.notes.list, {})).proposed).toMatchObject([{ _id: proposed.noteId, proposedByAgent: true, status: "proposed", authorHandle: "adalovelace" }]);
    expect((await tom.query(api.notes.list, {})).proposed).toHaveLength(1);
    expect((await jimmy.query(api.notes.list, {})).proposed).toEqual([]);
    // Not delivered, not on the wire, until it is approved.
    expect((await t.query(api.notes.forDaemon, { token })).notes).toEqual([]);
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "note"; })).toEqual([]);

    await expect(jimmy.mutation(api.notes.approve, { noteId: proposed.noteId })).rejects.toThrow("owner or the crew leader");
    await ada.mutation(api.notes.approve, { noteId: proposed.noteId });
    expect((await jimmy.query(api.notes.list, {})).live).toMatchObject([{ _id: proposed.noteId, status: "live", proposedByAgent: true }]);
    expect((await t.query(api.notes.forDaemon, { token })).notes.map(function (n) { return n.text; })).toEqual(["run bun test before pushing"]);
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "note"; })).toMatchObject([{ handle: "adalovelace", noteId: proposed.noteId }]);
    await expect(ada.mutation(api.notes.approve, { noteId: proposed.noteId })).rejects.toThrow("not waiting");

    // The leader rejects another: it is gone.
    const other = await t.mutation(api.notes.propose, { token, text: "always use tabs" });
    await tom.mutation(api.notes.reject, { noteId: other.noteId });
    const listed = await ada.query(api.notes.list, {});
    expect([listed.proposed, listed.retired]).toEqual([[], []]);
    await expect(t.mutation(api.notes.propose, { token: "sd_nope", text: "x" })).rejects.toThrow("Unknown daemon token");
  });

  test("a trusted crewmate's agents post at once on the team plan, while there is room", async function () {
    const t = harness();
    const { tom, ada, jimmy, crewId } = await crew(t);
    const adaToken = await daemonOf(ada, "am");
    const jimmyToken = await daemonOf(jimmy, "jm");
    await tom.mutation(api.crews.setTrustedNotePosters, { handles: ["adalovelace"] });
    // The free plan has no agent notes: it waits for Ada.
    expect((await t.mutation(api.notes.propose, { token: adaToken, text: "free plan proposal" })).status).toBe("proposed");
    await teamPlan(t, crewId);
    expect((await t.mutation(api.notes.propose, { token: adaToken, text: "the staging database is read-only today" })).status).toBe("live");
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "note"; })).toHaveLength(1);
    // Jimmy is not trusted: his agent's note waits for him.
    expect((await t.mutation(api.notes.propose, { token: jimmyToken, text: "jimmy's agent found the flaky test" })).status).toBe("proposed");
    // With the live notes full (60 on the team plan), even a trusted agent's note waits.
    const tomId = await idOf(t, "tom");
    await t.run(async function (ctx) {
      for (let i = 0; i < 59; i++) {
        await ctx.db.insert("notes", { crewId, authorId: tomId, text: `bulk ${i}`, tags: [], status: "live", createdAt: Date.now(), updatedAt: Date.now() });
      }
    });
    expect((await t.mutation(api.notes.propose, { token: adaToken, text: "no room left" })).status).toBe("proposed");
  });

  test("an agent's owner can have only so many proposals waiting", async function () {
    const t = harness();
    const { ada } = await crew(t);
    const token = await daemonOf(ada, "am");
    for (let i = 0; i < MAX_WAITING; i++) await t.mutation(api.notes.propose, { token, text: `proposal ${i}` });
    await expect(t.mutation(api.notes.propose, { token, text: "one more" })).rejects.toThrow(`${MAX_WAITING} crew notes waiting`);
  });

  test("a daemon gets the crew's live notes, newest first; nothing in no crew", async function () {
    const t = harness();
    const { tom, ada } = await crew(t);
    const token = await daemonOf(tom, "tm");
    await ada.mutation(api.notes.add, { text: "first", tags: ["infra"], appliesWhen: "infra/" });
    await Bun.sleep(3);
    const second = await tom.mutation(api.notes.add, { text: "second" });
    await Bun.sleep(3);
    await ada.mutation(api.notes.add, { text: "third" });
    await Bun.sleep(3);
    await tom.mutation(api.notes.edit, { noteId: second, text: "second, edited" });
    const delivered = await t.query(api.notes.forDaemon, { token });
    expect(delivered.notes.map(function (n) { return [n.text, n.authorHandle]; })).toEqual([
      ["second, edited", "tom"],
      ["third", "adalovelace"],
      ["first", "adalovelace"],
    ]);
    expect(delivered.notes[2]).toMatchObject({ tags: ["infra"], appliesWhen: "infra/" });
    expect(delivered.now).toBeGreaterThan(0);

    const sam = await hackerNamed(t, "sam");
    expect((await t.query(api.notes.forDaemon, { token: await daemonOf(sam, "sm") })).notes).toEqual([]);
  });
});
