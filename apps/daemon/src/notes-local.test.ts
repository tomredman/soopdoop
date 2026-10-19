// ABOUTME: Tests crew notes on the Mac: which notes apply where a session runs, the 2 KB block at a session's start, the line at
// ABOUTME: the next prompt when a note changes or is retired, crew.md, and the pointer blocks in Codex's and Grok's files.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applies, BLOCK_END, BLOCK_START, changesNote, crewMarkdown, installPointer, notesBlock, notesKeeper, parseCrewInfo, parseNotes,
  pointerBlock, uninstallPointer, withBlock, withoutBlock, writeCrewFile, type CrewNote,
} from "./notes-local";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-notes-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// Noon UTC, so the day is the same in every time zone a test runs in.
const OCT16 = Date.parse("2026-10-16T12:00:00Z");
const OCT17 = Date.parse("2026-10-17T12:00:00Z");

function note(id: string, text: string, updatedAt: number, extra: Partial<CrewNote> = {}): CrewNote {
  return { id, authorHandle: "adalovelace", text, tags: [], createdAt: updatedAt, updatedAt, ...extra };
}

const QUOTE = note("n1", "the quote page uses the M10 components.", OCT16, { appliesWhen: "quote" });
const LOB = note("n2", "Lob prices changed on Tuesday: postcards are $0.61.", OCT17, { authorHandle: "jimmy", appliesWhen: "vibes, pricing" });
const ALL = note("n3", "Ship from main only on weekdays.", OCT16 - 1000, { authorHandle: "tom" });

describe("which notes apply", function () {
  const vibes = { cwd: "/Users/ada/.superset/worktrees/vibes/quiet-otter", repo: "/Users/ada/projects/vibes", branch: "feat/quote-redesign" };
  const soop = { cwd: "/Users/ada/projects/soopdoop", repo: "/Users/ada/projects/soopdoop", branch: "main" };

  test("a note without applies-when goes everywhere; one with it, where its folder, repository, branch or words fit", function () {
    expect(applies(ALL, soop)).toBe(true);
    expect(applies(QUOTE, vibes)).toBe(true);
    expect(applies(QUOTE, soop)).toBe(false);
    expect(applies(LOB, vibes)).toBe(true);
    expect(applies(LOB, { ...soop, branch: "pricing-page" })).toBe(true);
    expect(applies(note("x", "t", 1, { appliesWhen: "apps/web/quote" }), { cwd: "/r/vibes/apps/web/quote" })).toBe(true);
    expect(applies(note("x", "t", 1, { appliesWhen: "apps/web/quote" }), { cwd: "/r/vibes" })).toBe(false);
    // Every word of one entry has to fit.
    expect(applies(note("x", "t", 1, { appliesWhen: "quote page" }), vibes)).toBe(false);
  });

  test("reads the backend's notes and crew defensively, newest first", function () {
    expect(parseNotes({ now: 5, notes: [ALL, { id: 1 }, QUOTE, { ...LOB, appliesWhen: " " }] })?.notes.map(function (n) { return [n.id, n.appliesWhen]; })).toEqual([["n2", undefined], ["n1", "quote"], ["n3", undefined]]);
    expect(parseNotes(null)).toBeNull();
    expect(parseCrewInfo({ crewName: "Vibes", plan: "team", leaderHandle: "tom", members: [{ handle: "jimmy" }, { handle: 2 }] })).toEqual({ crewName: "Vibes", plan: "team", leaderHandle: "tom", members: [{ handle: "jimmy" }] });
  });
});

describe("what a session is told", function () {
  test("at its start: the notes that apply, newest first, in at most 2 KB", function () {
    const block = notesBlock([LOB, QUOTE, ALL], { cwd: "/r/vibes", repo: "/r/vibes", branch: "feat/quote" });
    expect(block.text?.split("\n")).toEqual([
      "soopdoop: your crew's notes, newest first. A crew note outranks what you remember about the same thing, and a note with a date is the current one.",
      "- @jimmy (17 Oct): Lob prices changed on Tuesday: postcards are $0.61.",
      "- @adalovelace (16 Oct): the quote page uses the M10 components.",
      "- @tom (16 Oct): Ship from main only on weekdays.",
    ]);
    const many = Array.from({ length: 30 }, function (_, i) { return note(`m${i}`, `rule number ${i}: ${"x".repeat(150)}`, OCT17 - i); });
    const big = notesBlock(many, {});
    expect(Buffer.byteLength(big.text ?? "")).toBeLessThanOrEqual(2_048);
    expect(big.text).toContain(`- and ${30 - big.told.length} more: crew_notes lists them all.`);
    expect(notesBlock([QUOTE], { cwd: "/r/soopdoop" }).text).toBeNull();
  });

  test("one changed note at the next prompt, in the plan's words; several, and retired ones, each on a line", function () {
    expect(changesNote([QUOTE], [])).toBe("soopdoop: a crew note changed. @adalovelace (16 Oct): the quote page uses the M10 components.");
    expect(changesNote([LOB, QUOTE], [ALL])?.split("\n")).toEqual([
      "soopdoop: 2 crew notes changed.",
      "- @jimmy (17 Oct): Lob prices changed on Tuesday: postcards are $0.61.",
      "- @adalovelace (16 Oct): the quote page uses the M10 components.",
      "soopdoop: a crew note was retired and no longer stands: @tom (16 Oct): Ship from main only on weekdays.",
    ]);
    expect(changesNote([], [])).toBeNull();
  });

  test("the keeper: the block at the start, nothing while nothing changes, then one line per change", async function () {
    let changes = 0;
    const keeper = notesKeeper({ changed() { changes += 1; } });
    const place = { cwd: "/r/vibes", repo: "/r/vibes", branch: "feat/quote" };
    keeper.set({ now: OCT17, notes: [QUOTE, ALL] });
    expect(changes).toBe(1);
    expect(await keeper.contextFor("SessionStart", "s1", place)).toContain("the quote page uses the M10 components.");
    expect(await keeper.contextFor("UserPromptSubmit", "s1", place)).toBeNull();
    expect(await keeper.contextFor("PreToolUse", "s1", place)).toBeNull();
    // Ada edits her note; the copy arrives (the daemon follows notes:forDaemon live).
    const edited = { ...QUOTE, text: "the quote page uses the M10 components; do not touch the old Form.tsx.", updatedAt: OCT17 + 5 };
    keeper.set({ now: OCT17 + 6, notes: [edited, ALL] });
    keeper.set({ now: OCT17 + 7, notes: [edited, ALL] });
    expect(changes).toBe(2);
    expect(await keeper.contextFor("UserPromptSubmit", "s1", place)).toBe(
      "soopdoop: a crew note changed. @adalovelace (17 Oct): the quote page uses the M10 components; do not touch the old Form.tsx.",
    );
    expect(await keeper.contextFor("UserPromptSubmit", "s1", place)).toBeNull();
    // A note for another place changes: this session hears nothing.
    keeper.set({ now: OCT17 + 9, notes: [edited, ALL, { ...LOB, appliesWhen: "soopdoop", updatedAt: OCT17 + 8 }] });
    expect(await keeper.contextFor("UserPromptSubmit", "s1", place)).toBeNull();
    // Tom retires his note.
    keeper.set({ now: OCT17 + 10, notes: [edited, { ...LOB, appliesWhen: "soopdoop", updatedAt: OCT17 + 8 }] });
    expect(await keeper.contextFor("UserPromptSubmit", "s1", place)).toBe(
      "soopdoop: a crew note was retired and no longer stands: @tom (16 Oct): Ship from main only on weekdays.",
    );
  });

  test("a session it did not see start gets the block at its first prompt; before any copy, it reads once", async function () {
    let reads = 0;
    const keeper = notesKeeper({ async readNotes() { reads += 1; return { now: OCT17, notes: [ALL] }; } });
    expect(await keeper.contextFor("UserPromptSubmit", "s2", {})).toContain("Ship from main only on weekdays.");
    expect(reads).toBe(1);
    keeper.keepOnly(new Set());
    expect(await keeper.contextFor("UserPromptSubmit", "s2", {})).toContain("Ship from main only on weekdays.");
    const slow = notesKeeper({ readNotes() { return new Promise(function () { /* never */ }); }, waitMs: 20 });
    expect(await slow.contextFor("SessionStart", "s3", {})).toBeNull();
  });
});

describe("crew.md and the pointers to it", function () {
  test("crew.md: the crew, crewmates with their running agents, every live note, and how to ask", async function () {
    const text = crewMarkdown(
      { crewName: "Vibes crew", plan: "team", leaderHandle: "tom", members: [{ handle: "adalovelace", name: "Ada Lovelace" }, { handle: "jimmy" }] },
      { now: OCT17, agents: [{ key: "k1", handle: "jimmy", status: "working", summary: '"fix the bounces" · files: packages/email/metrics.ts', since: 1 }] },
      { now: OCT17, notes: [QUOTE, ALL] },
    );
    expect(text).toContain("Crew: Vibes crew (led by @tom).");
    expect(text).toContain("- @adalovelace (Ada Lovelace): no agent running now");
    expect(text).toContain("- @jimmy: 1 agent running now\n  - @jimmy, working: \"fix the bounces\" · files: packages/email/metrics.ts");
    expect(text).toContain("- @adalovelace (16 Oct): the quote page uses the M10 components. (applies when: quote)");
    expect(text).toContain("call the soopdoop tool ask_operator with their @handle");
    const dir = await tempDir();
    const file = path.join(dir, "crew.md");
    expect(await writeCrewFile(text, file)).toBe(true);
    expect(await writeCrewFile(text, file)).toBe(false);
    expect(await readFile(file, "utf8")).toBe(text);
    // Writes that start together (a note and the crew arriving at once) each use their own temporary file.
    await Promise.all([writeCrewFile("one", file), writeCrewFile("two", file), writeCrewFile("three", file)]);
    expect(["one", "two", "three"]).toContain(await readFile(file, "utf8"));
  });

  test("the block goes in and out, and every other byte of the file stays as it was", function () {
    const block = pointerBlock("/Users/ada/.soopdoop/crew.md");
    expect(block).toBe(`${BLOCK_START}\nRead /Users/ada/.soopdoop/crew.md: your crew's notes and agents\n${BLOCK_END}`);
    for (const original of ["", "# My rules\n\nUse bun.\n", "no newline at the end", "a\n\n\n"]) {
      const installed = withBlock(original, block);
      expect(installed).toContain(block);
      expect(withBlock(installed, block)).toBe(installed);
      expect(withoutBlock(installed)).toBe(original);
    }
    // A block written by an older version is replaced in place.
    const old = `top\n${BLOCK_START}\nold words\n${BLOCK_END}\nbottom\n`;
    expect(withBlock(old, block)).toBe(`top\n${block}\nbottom\n`);
    expect(withoutBlock("no block here\n")).toBe("no block here\n");
  });

  test("Codex's AGENTS.md keeps its own text; Grok's rule file, which is ours alone, goes when the block does", async function () {
    const dir = await tempDir();
    const agents = path.join(dir, ".codex", "AGENTS.md");
    const mine = "# Global rules\n\nAlways run the tests.\n";
    await installPointer(agents, pointerBlock()).then(async function () {
      // Created from nothing.
      expect(await readFile(agents, "utf8")).toBe(`${pointerBlock()}\n`);
    });
    await writeFile(agents, mine);
    expect(await installPointer(agents)).toBe(true);
    expect(await installPointer(agents)).toBe(false);
    expect(await uninstallPointer(agents)).toBe(true);
    expect(await readFile(agents, "utf8")).toBe(mine);
    expect(await uninstallPointer(agents)).toBe(false);

    const rule = path.join(dir, ".grok", "rules", "soopdoop.md");
    await installPointer(rule);
    expect(await uninstallPointer(rule, true)).toBe(true);
    expect(await Bun.file(rule).exists()).toBe(false);
  });
});
