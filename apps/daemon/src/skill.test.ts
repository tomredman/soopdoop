import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CREW_TOOL, TOOL } from "./mcp";
import { installSkill, removeSkill, skillDir, skillInstalled } from "./skill";

const SKILL = path.resolve(import.meta.dir, "..", "..", "..", "packages", "plugin", "skills", "soopdoop", "SKILL.md");

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-skill-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("the soopdoop skill", function () {
  test("names itself and points agents at the ask_operator tool", async function () {
    const text = await readFile(SKILL, "utf8");
    expect(text.startsWith("---\nname: soopdoop\ndescription: ")).toBe(true);
    // A colon followed by a space would end the description early: it is YAML.
    const description = /^description: (.*)$/m.exec(text)?.[1] ?? "";
    expect(description).toContain("ask_operator");
    expect(description).not.toContain(": ");
    // The body names both of the MCP server's tools as the server names them.
    for (const name of [TOOL.name, CREW_TOOL.name]) expect(text).toContain(`\`${name}\``);
  });

  test("installs as a copy, installs again over itself, and uninstalls", async function () {
    const home = await tempHome();
    expect(await skillInstalled(home)).toBe(false);
    const target = await installSkill(SKILL, home);
    expect(target).toBe(path.join(home, ".claude", "skills", "soopdoop", "SKILL.md"));
    expect(await readFile(target, "utf8")).toBe(await readFile(SKILL, "utf8"));
    await installSkill(SKILL, home);
    expect(await skillInstalled(home)).toBe(true);
    expect(await removeSkill(home)).toBe(true);
    expect(await skillInstalled(home)).toBe(false);
    expect(await readdir(path.join(home, ".claude", "skills"))).toEqual([]);
    expect(await removeSkill(home)).toBe(false);
  });

  test("never removes a skill or a file that is not ours", async function () {
    const home = await tempHome();
    await mkdir(skillDir(home), { recursive: true });
    await writeFile(path.join(skillDir(home), "SKILL.md"), "---\nname: something-else\n---\n");
    expect(await removeSkill(home)).toBe(false);
    expect(await skillInstalled(home)).toBe(true);

    await installSkill(SKILL, home);
    await writeFile(path.join(skillDir(home), "notes.md"), "mine");
    expect(await removeSkill(home)).toBe(true);
    expect(await readdir(skillDir(home))).toEqual(["notes.md"]);
  });
});
