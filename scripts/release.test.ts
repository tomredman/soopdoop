import { describe, expect, test } from "bun:test";
import { bumpVersion, releaseNotes, withEntry, withVersion } from "./release";

describe("release", function () {
  test("bumps versions", function () {
    expect(bumpVersion("0.0.1", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(bumpVersion("0.9.3", "major")).toBe("1.0.0");
    expect(function () { bumpVersion("1.0", "patch"); }).toThrow("not X.Y.Z");
  });

  test("groups commit subjects into notes and leaves release commits out", function () {
    expect(releaseNotes([
      "feat(rail): pair this machine from the page",
      "fix(rail): the empty friends list names the invite button",
      "docs: how to try soopdoop",
      "chore(convex): lint Convex functions",
      "chore(release): v0.1.0",
      "Merge something odd",
    ])).toBe([
      "### New",
      "- pair this machine from the page (rail)",
      "",
      "### Fixes",
      "- the empty friends list names the invite button (rail)",
      "",
      "### Docs",
      "- how to try soopdoop",
      "",
      "### Other",
      "- lint Convex functions (convex)",
      "- Merge something odd",
    ].join("\n"));
    expect(releaseNotes(["chore(release): v0.1.0"])).toBe("No changes since the last release.");
  });

  test("puts the newest changelog entry first", function () {
    const first = withEntry("", "v0.1.0", "2026-10-02", "### New\n- a");
    expect(first).toBe("# Changelog\n\n## v0.1.0 · 2026-10-02\n\n### New\n- a\n");
    expect(withEntry(first, "v0.1.1", "2026-10-03", "### Fixes\n- b")).toBe(
      "# Changelog\n\n## v0.1.1 · 2026-10-03\n\n### Fixes\n- b\n\n## v0.1.0 · 2026-10-02\n\n### New\n- a\n",
    );
  });

  test("changes only the version line of package.json", function () {
    const text = '{\n  "name": "soopdoop",\n  "version": "0.0.1",\n  "workspaces": ["apps/*"]\n}\n';
    expect(withVersion(text, "0.1.0")).toBe('{\n  "name": "soopdoop",\n  "version": "0.1.0",\n  "workspaces": ["apps/*"]\n}\n');
    expect(function () { withVersion("{}", "0.1.0"); }).toThrow("No version line");
  });
});
