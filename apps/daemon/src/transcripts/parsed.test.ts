// ABOUTME: Tests the helpers every transcript reader shares: turns and prompts, PR links, and telling a merge into main from
// ABOUTME: other git commands. Pure functions with made-up commands.
import { describe, expect, test } from "bun:test";
import { addTurn, emptyParsed, mergesIntoMain, noteCommand, prUrls } from "./parsed";

describe("the shared transcript shape", function () {
  test("a user turn is a prompt: the first one is kept, the last one follows; long turns are cut", function () {
    const parsed = emptyParsed();
    addTurn(parsed, "user", "  add\ncoupons  ");
    addTurn(parsed, "assistant", "x".repeat(5_000));
    addTurn(parsed, "user", "round them");
    addTurn(parsed, "user", "   ");
    expect(parsed.firstPrompt).toBe("add coupons");
    expect(parsed.lastPrompt).toBe("round them");
    expect(parsed.turns.map(function (t) { return t.text.length; })).toEqual([11, 4_001, 10]);
  });

  test("finds pull request links on any GitHub host", function () {
    expect(prUrls("see https://github.com/example-org/vibes/pull/12, and https://git.example.com/team/app/pull/3.")).toEqual([
      "https://github.com/example-org/vibes/pull/12",
      "https://git.example.com/team/app/pull/3",
    ]);
    expect(prUrls("https://github.com/example-org/vibes/issues/4")).toEqual([]);
  });

  test("tells a merge into main from other git commands", function () {
    expect(mergesIntoMain("git merge feat/x", "main")).toBe(true);
    expect(mergesIntoMain("git merge feat/x", "master")).toBe(true);
    expect(mergesIntoMain("git merge --abort", "main")).toBe(false);
    expect(mergesIntoMain("git merge main", "feat/x")).toBe(false);
    expect(mergesIntoMain("git checkout main && git pull && git merge --no-ff feat/x", "feat/x")).toBe(true);
    expect(mergesIntoMain("git switch main; git merge feat/x", undefined)).toBe(true);
    expect(mergesIntoMain("git push origin HEAD:main", "feat/x")).toBe(true);
    expect(mergesIntoMain("git push origin feat/x:refs/heads/main", "feat/x")).toBe(true);
    expect(mergesIntoMain("git push origin main:main", "main")).toBe(false);
    expect(mergesIntoMain("git push origin :main", "feat/x")).toBe(false);
    expect(mergesIntoMain("git push -u origin feat/x", "feat/x")).toBe(false);
  });

  test("a command whose exit code is unknown counts unless its output says it failed", function () {
    const parsed = emptyParsed();
    noteCommand(parsed, "gh pr merge 5 --squash", "GraphQL: Pull request is not mergeable (mergePullRequest)", undefined);
    expect(parsed.merged).toBe(false);
    noteCommand(parsed, "gh pr create --fill", "https://github.com/example-org/vibes/pull/6\n", undefined);
    noteCommand(parsed, "gh pr create --fill", "https://github.com/example-org/vibes/pull/6\n", undefined);
    expect(parsed.prLinks).toEqual(["https://github.com/example-org/vibes/pull/6"]);
    noteCommand(parsed, "gh pr merge 6 --squash", "✓ Squashed and merged pull request example-org/vibes#6", undefined);
    expect(parsed.merged).toBe(true);
  });
});
