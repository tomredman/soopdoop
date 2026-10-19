// ABOUTME: Crew notes: live shared instructions, up to 400 characters each, that reach every crewmate's agent (plan-crews §7).
// ABOUTME: People add them; an agent proposes one for its owner to approve, or posts it when the leader trusts it. Age is computed.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { requireDaemon, requireHacker } from "./lib/auth";
import { crewOf } from "./lib/crew";
import { DAY_MS } from "./lib/localTime";
import { limitsFor } from "./lib/plan";
import { redactSecrets } from "./lib/summaries";
import { noteStatus } from "./schema";
import { supersetCard } from "./superset";

export const MAX_NOTE = 400;
const MAX_TAGS = 5;
const MAX_TAG = 24;
const MAX_APPLIES_WHEN = 120;
// "Still true?" after 30 days without a confirmation; not delivered to agents after 45.
export const NUDGE_DAYS = 30;
export const STALE_DAYS = 45;
// The most live notes one delivery carries (the team plan's cap).
const MAX_DELIVERED = 60;
// Proposals one hacker's agents may have waiting at once.
export const MAX_WAITING = 20;
// How much of a note the wire shows.
const WIRE_CHARS = 120;
const NO_CREW = "Crew notes belong to a crew. Start one in Settings → Crew.";

const noteView = v.object({
  _id: v.id("notes"),
  text: v.string(),
  tags: v.array(v.string()),
  authorHandle: v.string(),
  authorName: v.optional(v.string()),
  status: noteStatus,
  proposedByAgent: v.boolean(),
  appliesWhen: v.optional(v.string()),
  confirmBy: v.optional(v.number()),
  replaces: v.optional(v.id("notes")),
  createdAt: v.number(),
  updatedAt: v.number(),
  confirmedAt: v.optional(v.number()),
  retiredAt: v.optional(v.number()),
  // Time for its author to say whether it is still true: 30 days since it was last confirmed, or its confirm-by date passed.
  nudge: v.boolean(),
  // 45 days without a confirmation: no longer delivered to agents, still listed.
  stale: v.boolean(),
});

type NoteAge = Pick<Doc<"notes">, "status" | "createdAt" | "confirmedAt" | "confirmBy">;

function lastConfirmed(n: NoteAge): number {
  return n.confirmedAt ?? n.createdAt;
}

export function needsNudge(n: NoteAge, now: number): boolean {
  if (n.status !== "live") return false;
  if (now - lastConfirmed(n) >= NUDGE_DAYS * DAY_MS) return true;
  return n.confirmBy !== undefined && n.confirmBy <= now && (n.confirmedAt === undefined || n.confirmedAt < n.confirmBy);
}

export function isStale(n: NoteAge, now: number): boolean {
  return n.status === "live" && now - lastConfirmed(n) >= STALE_DAYS * DAY_MS;
}

// Lowercase words with hyphens ("design", "pricing", "infra"), at most 5, no repeats.
export function cleanTags(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of raw ?? []) {
    const tag = t.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_TAG);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

// Crewmates' agents read notes, so nothing that looks like a key is kept.
function cleanText(raw: string): string {
  const text = redactSecrets(raw.trim());
  if (text === "") throw new ConvexError("Write the note first.");
  if (text.length > MAX_NOTE) throw new ConvexError(`Keep a note under ${MAX_NOTE} characters.`);
  return text;
}

function cleanAppliesWhen(raw: string | undefined | null): string | undefined {
  const s = (raw ?? "").trim().slice(0, MAX_APPLIES_WHEN);
  return s === "" ? undefined : s;
}

async function notesWith(ctx: QueryCtx, crewId: Id<"crews">, status: Doc<"notes">["status"]): Promise<Doc<"notes">[]> {
  return await ctx.db
    .query("notes")
    .withIndex("by_crew_status", function (q) {
      return q.eq("crewId", crewId).eq("status", status);
    })
    .collect();
}

function newestFirst(notes: Doc<"notes">[]): Doc<"notes">[] {
  return notes.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
}

async function view(ctx: QueryCtx, n: Doc<"notes">, now: number) {
  const author = await ctx.db.get("hackers", n.authorId);
  return {
    _id: n._id,
    text: n.text,
    tags: n.tags,
    authorHandle: author?.handle ?? "",
    authorName: (await supersetCard(ctx, n.authorId))?.name,
    status: n.status,
    proposedByAgent: n.proposedByAgent === true,
    appliesWhen: n.appliesWhen,
    confirmBy: n.confirmBy,
    replaces: n.replaces,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    confirmedAt: n.confirmedAt,
    retiredAt: n.retiredAt,
    nudge: needsNudge(n, now),
    stale: isStale(n, now),
  };
}

type NoteView = Awaited<ReturnType<typeof view>>;

// Throws when the crew already has as many live notes as its plan allows. `freeing`: live notes this change retires.
async function needRoom(ctx: QueryCtx, crew: Doc<"crews">, freeing: number): Promise<void> {
  const live = (await notesWith(ctx, crew._id, "live")).length;
  const limit = limitsFor(crew).liveNotes;
  if (live - freeing >= limit) {
    throw new ConvexError(`Your crew has ${live} live notes, the most on the ${crew.plan} plan. Retire one first.`);
  }
}

async function hasRoom(ctx: QueryCtx, crew: Doc<"crews">): Promise<boolean> {
  return (await notesWith(ctx, crew._id, "live")).length < limitsFor(crew).liveNotes;
}

// The wire hears about a note when it goes live.
async function announce(ctx: MutationCtx, note: Doc<"notes">, now: number): Promise<void> {
  await addToFeed(ctx, { kind: "note", hackerId: note.authorId, text: note.text.slice(0, WIRE_CHARS), noteId: note._id, at: now });
}

async function goLive(ctx: MutationCtx, note: Doc<"notes">, now: number): Promise<void> {
  if (note.replaces !== undefined) {
    const old = await ctx.db.get("notes", note.replaces);
    if (old !== null && old.crewId === note.crewId && old.status === "live") {
      await ctx.db.patch("notes", old._id, { status: "retired", retiredAt: now });
    }
  }
  await announce(ctx, note, now);
}

// A note in the caller's crew, and the crew.
async function myCrewNote(ctx: QueryCtx, me: Doc<"hackers">, noteId: Id<"notes">): Promise<{ note: Doc<"notes">; crew: Doc<"crews"> }> {
  const crew = await crewOf(ctx, me._id);
  const note = await ctx.db.get("notes", noteId);
  if (crew === null || note === null || note.crewId !== crew._id) throw new ConvexError("That note is not in your crew.");
  return { note, crew };
}

function mayChange(me: Doc<"hackers">, note: Doc<"notes">, crew: Doc<"crews">): boolean {
  return note.authorId === me._id || crew.leaderId === me._id;
}

// My crew's notes: the live ones, the proposals waiting for me (mine; all of them for the leader), the last 10 retired.
export const list = query({
  args: {},
  returns: v.object({ live: v.array(noteView), proposed: v.array(noteView), retired: v.array(noteView) }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    if (crew === null) return { live: [], proposed: [], retired: [] };
    const now = Date.now();
    const live = newestFirst(await notesWith(ctx, crew._id, "live"));
    const proposed = newestFirst(await notesWith(ctx, crew._id, "proposed")).filter(function (n) {
      return crew.leaderId === me._id || n.authorId === me._id;
    });
    const retired = await ctx.db
      .query("notes")
      .withIndex("by_crew_status", function (q) {
        return q.eq("crewId", crew._id).eq("status", "retired");
      })
      .order("desc")
      .take(50);
    retired.sort(function (a, b) { return (b.retiredAt ?? b.updatedAt) - (a.retiredAt ?? a.updatedAt); });
    const out: { live: NoteView[]; proposed: NoteView[]; retired: NoteView[] } = { live: [], proposed: [], retired: [] };
    for (const n of live) out.live.push(await view(ctx, n, now));
    for (const n of proposed) out.proposed.push(await view(ctx, n, now));
    for (const n of retired.slice(0, 10)) out.retired.push(await view(ctx, n, now));
    return out;
  },
});

// A new live note from a person in the crew. `replaces` retires the live note it updates.
export const add = mutation({
  args: {
    text: v.string(),
    tags: v.optional(v.array(v.string())),
    confirmBy: v.optional(v.number()),
    appliesWhen: v.optional(v.string()),
    replaces: v.optional(v.id("notes")),
  },
  returns: v.id("notes"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    if (crew === null) throw new ConvexError(NO_CREW);
    const text = cleanText(args.text);
    if (args.replaces !== undefined) {
      const old = await ctx.db.get("notes", args.replaces);
      if (old === null || old.crewId !== crew._id || old.status !== "live") throw new ConvexError("The note it replaces is not a live note in your crew.");
    }
    await needRoom(ctx, crew, args.replaces === undefined ? 0 : 1);
    const now = Date.now();
    const noteId = await ctx.db.insert("notes", {
      crewId: crew._id,
      authorId: me._id,
      text,
      tags: cleanTags(args.tags),
      confirmBy: args.confirmBy,
      appliesWhen: cleanAppliesWhen(args.appliesWhen),
      replaces: args.replaces,
      status: "live",
      proposedByAgent: false,
      createdAt: now,
      updatedAt: now,
    });
    const note = await ctx.db.get("notes", noteId);
    if (note !== null) await goLive(ctx, note, now);
    return noteId;
  },
});

// Changes a note (its author or the crew leader). Null clears confirm-by or applies-when. A change counts as a confirmation.
export const edit = mutation({
  args: {
    noteId: v.id("notes"),
    text: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    confirmBy: v.optional(v.union(v.number(), v.null())),
    appliesWhen: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { note, crew } = await myCrewNote(ctx, me, args.noteId);
    if (!mayChange(me, note, crew)) throw new ConvexError("Only the note's author or the crew leader can change it.");
    if (note.status === "retired") throw new ConvexError("That note is retired.");
    const now = Date.now();
    const patch: Partial<Doc<"notes">> = { updatedAt: now };
    if (note.status === "live") patch.confirmedAt = now;
    if (args.text !== undefined) patch.text = cleanText(args.text);
    if (args.tags !== undefined) patch.tags = cleanTags(args.tags);
    if (args.confirmBy !== undefined) patch.confirmBy = args.confirmBy ?? undefined;
    if (args.appliesWhen !== undefined) patch.appliesWhen = cleanAppliesWhen(args.appliesWhen);
    await ctx.db.patch("notes", note._id, patch);
    return null;
  },
});

// "Still true": the note's age starts again.
export const confirm = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { note, crew } = await myCrewNote(ctx, me, args.noteId);
    if (!mayChange(me, note, crew)) throw new ConvexError("Only the note's author or the crew leader can confirm it.");
    if (note.status !== "live") throw new ConvexError("Only a live note can be confirmed.");
    await ctx.db.patch("notes", note._id, { confirmedAt: Date.now() });
    return null;
  },
});

// Takes a note off: no longer delivered, still in the history.
export const retire = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { note, crew } = await myCrewNote(ctx, me, args.noteId);
    if (!mayChange(me, note, crew)) throw new ConvexError("Only the note's author or the crew leader can retire it.");
    if (note.status === "retired") return null;
    await ctx.db.patch("notes", note._id, { status: "retired", retiredAt: Date.now() });
    return null;
  },
});

// An agent's proposal goes live: its owner (the note's author) or the crew leader says yes.
export const approve = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { note, crew } = await myCrewNote(ctx, me, args.noteId);
    if (!mayChange(me, note, crew)) throw new ConvexError("Only the agent's owner or the crew leader can approve this note.");
    if (note.status !== "proposed") throw new ConvexError("That note is not waiting for approval.");
    const replaced = note.replaces === undefined ? null : await ctx.db.get("notes", note.replaces);
    await needRoom(ctx, crew, replaced !== null && replaced.status === "live" ? 1 : 0);
    const now = Date.now();
    await ctx.db.patch("notes", note._id, { status: "live", updatedAt: now, confirmedAt: now });
    await goLive(ctx, note, now);
    return null;
  },
});

// An agent's proposal is dropped: it never reached the crew, so nothing is kept.
export const reject = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { note, crew } = await myCrewNote(ctx, me, args.noteId);
    if (!mayChange(me, note, crew)) throw new ConvexError("Only the agent's owner or the crew leader can reject this note.");
    if (note.status !== "proposed") throw new ConvexError("That note is not waiting for approval.");
    await ctx.db.delete("notes", note._id);
    return null;
  },
});

// From an agent (the crew_note tool, through its machine's token). It waits for its owner's approval, unless the leader
// trusts the owner's agents and the plan lets agents post: then it is live at once. The same text twice is one note.
export const propose = mutation({
  args: {
    token: v.string(),
    text: v.string(),
    tags: v.optional(v.array(v.string())),
    appliesWhen: v.optional(v.string()),
    confirmBy: v.optional(v.number()),
  },
  returns: v.object({ noteId: v.id("notes"), status: v.union(v.literal("proposed"), v.literal("live")) }),
  handler: async function (ctx, args): Promise<{ noteId: Id<"notes">; status: "proposed" | "live" }> {
    const { hacker } = await requireDaemon(ctx, args.token);
    const crew = await crewOf(ctx, hacker._id);
    if (crew === null) throw new ConvexError(NO_CREW);
    const text = cleanText(args.text);
    const live = await notesWith(ctx, crew._id, "live");
    const waiting = await notesWith(ctx, crew._id, "proposed");
    const same = [...live, ...waiting].find(function (n) { return n.text.toLowerCase() === text.toLowerCase(); });
    if (same !== undefined) return { noteId: same._id, status: same.status === "live" ? "live" : "proposed" };
    if (waiting.filter(function (n) { return n.authorId === hacker._id; }).length >= MAX_WAITING) {
      throw new ConvexError(`You have ${MAX_WAITING} crew notes waiting for approval in soopdoop. Approve or reject some first.`);
    }
    const trusted = limitsFor(crew).agentNotes && (crew.trustedNotePosters ?? []).includes(hacker._id);
    const status = trusted && (await hasRoom(ctx, crew)) ? "live" : "proposed";
    const now = Date.now();
    const noteId = await ctx.db.insert("notes", {
      crewId: crew._id,
      authorId: hacker._id,
      text,
      tags: cleanTags(args.tags),
      confirmBy: args.confirmBy,
      appliesWhen: cleanAppliesWhen(args.appliesWhen),
      status,
      proposedByAgent: true,
      createdAt: now,
      updatedAt: now,
    });
    if (status === "live") {
      const note = await ctx.db.get("notes", noteId);
      if (note !== null) await goLive(ctx, note, now);
    }
    return { noteId, status };
  },
});

// What a machine's daemon delivers to its agents: the crew's live notes that are not stale, newest first, at most 60.
// `now` is the server's clock, for the notes' age.
export const forDaemon = query({
  args: { token: v.string() },
  returns: v.object({
    now: v.number(),
    notes: v.array(v.object({
      id: v.id("notes"),
      authorHandle: v.string(),
      text: v.string(),
      tags: v.array(v.string()),
      appliesWhen: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })),
  }),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const now = Date.now();
    const crew = await crewOf(ctx, hacker._id);
    if (crew === null) return { now, notes: [] };
    const fresh = newestFirst(await notesWith(ctx, crew._id, "live")).filter(function (n) { return !isStale(n, now); });
    const notes = [];
    for (const n of fresh.slice(0, MAX_DELIVERED)) {
      const author = await ctx.db.get("hackers", n.authorId);
      notes.push({ id: n._id, authorHandle: author?.handle ?? "", text: n.text, tags: n.tags, appliesWhen: n.appliesWhen, createdAt: n.createdAt, updatedAt: n.updatedAt });
    }
    return { now, notes };
  },
});
