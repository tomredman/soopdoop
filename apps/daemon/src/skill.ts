// ABOUTME: Installs the soopdoop skill into Claude Code (~/.claude/skills/soopdoop/SKILL.md), which tells every session when to
// ABOUTME: ask the Operator. A copy, written again by every setup and update, so Claude Code never holds a path into the checkout.
import { mkdir, readFile, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function skillDir(home: string = homedir()): string {
  return path.join(home, ".claude", "skills", "soopdoop");
}

export async function installSkill(source: string, home: string = homedir()): Promise<string> {
  const target = path.join(skillDir(home), "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await Bun.write(target, Bun.file(source));
  return target;
}

export async function skillInstalled(home: string = homedir()): Promise<boolean> {
  return await Bun.file(path.join(skillDir(home), "SKILL.md")).exists();
}

// Removes our SKILL.md, and the folder if nothing else is in it. A skill there that is not ours stays.
export async function removeSkill(home: string = homedir()): Promise<boolean> {
  const file = path.join(skillDir(home), "SKILL.md");
  const text = await readFile(file, "utf8").catch(function () { return null; });
  if (text === null || !/^name:\s*soopdoop\s*$/m.test(text)) return false;
  await unlink(file);
  await rmdir(skillDir(home)).catch(function () { /* something else is in the folder */ });
  return true;
}
