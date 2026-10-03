import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Production deployments hide the text of a plain Error from clients: the app shows "Server Error". Only a ConvexError's
// message (its data) gets through, so functions throw ConvexError for anything a hacker should read.
describe("errors", function () {
  test("functions throw ConvexError, never a plain Error", async function () {
    const dir = import.meta.dir;
    const skip = new Set(["auth.config.ts", "testing.helpers.ts"]);
    const files = (await readdir(dir, { recursive: true })).filter(function (f) {
      return f.endsWith(".ts") && !f.includes(".test.") && !f.startsWith("_generated") && !skip.has(f);
    });
    const plain: string[] = [];
    for (const f of files) {
      const lines = (await Bun.file(path.join(dir, f)).text()).split("\n");
      lines.forEach(function (line, i) {
        if (line.includes("throw new Error(")) plain.push(`${f}:${i + 1}`);
      });
    }
    expect(files.length).toBeGreaterThan(5);
    expect(plain).toEqual([]);
  });
});
