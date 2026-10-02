// ABOUTME: Reads a Superset leaderboard profile from its public markdown page, https://superset.sh/md/user/<handle>.
// ABOUTME: Pure functions. Keeps name, tier, achievements and model names; token counts are read only to sort models.

export const SUPERSET_SITE = "https://superset.sh";

// Superset's own handle shape (its `handles` table), which is also soopdoop's.
const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Achievement {
  slug: string;
  level?: number;
  of?: number;
}

export interface SupersetProfile {
  handle: string;
  name?: string;
  tier?: string;
  achievements: Achievement[];
  // Most tokens first. Names only: AGENTS.md keeps token counts off personal and crew boards.
  models: string[];
}

export function profileMarkdownUrl(handle: string): string {
  return `${SUPERSET_SITE}/md/user/${handle}`;
}

export function profilePageUrl(handle: string): string {
  return `${SUPERSET_SITE}/${handle}`;
}

// Takes "ada-lovelace", "@ada-lovelace", or a pasted profile URL. Null for anything that is not a Superset handle.
export function normalizeHandle(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  const fromUrl = /^(?:https?:\/\/)?(?:www\.)?superset\.sh\/(?:md\/user\/)?([^/?#\s]+)\/?(?:[?#].*)?$/.exec(s);
  const slug = fromUrl?.[1];
  if (slug !== undefined) s = slug;
  s = s.replace(/^@/, "");
  if (s.length < 2 || s.length > 39 || !HANDLE.test(s)) return null;
  return s;
}

// The page prints counts the way Superset's compact() does: "21.73B", "53.5M", "1.0K", "740".
export function compactNumber(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([KMB]?)$/.exec(text.trim());
  if (m === null) return 0;
  const scale = m[2] === "B" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1;
  return Number(m[1]) * scale;
}

// The lines under "## <title>", up to the next "## " heading.
function section(md: string, title: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex(function (line) {
    return line.trim() === `## ${title}`;
  });
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

function achievementFrom(line: string): Achievement | null {
  // "- **ship-it** (level 2 of 4) at 10, earned 2026-09-07", or "- some-slug" when Superset has no definition for it.
  const m = /^- (?:\*\*([a-z0-9_-]+)\*\*|([a-z0-9_-]+)\s*$)(?: \(level (\d+) of (\d+)\))?/.exec(line.trim());
  if (m === null) return null;
  const slug = m[1] ?? m[2];
  if (slug === undefined) return null;
  const achievement: Achievement = { slug };
  if (m[3] !== undefined && m[4] !== undefined) {
    achievement.level = Number(m[3]);
    achievement.of = Number(m[4]);
  }
  return achievement;
}

// Model names from the "Models" table, most tokens first. Skips the header, the divider and "unknown".
function modelsFrom(lines: string[]): string[] {
  const rows: { model: string; tokens: number }[] = [];
  for (const line of lines) {
    const cells = line.trim().split("|").map(function (cell) { return cell.trim(); });
    // "| codex | gpt-5.6-sol | 21.73B | $16312.52 |" splits into six cells, the first and last empty.
    if (cells.length !== 6) continue;
    const model = cells[2];
    const tokens = cells[3];
    if (model === undefined || tokens === undefined) continue;
    if (model === "" || model === "Model" || model === "unknown" || /^-+$/.test(model)) continue;
    rows.push({ model, tokens: compactNumber(tokens) });
  }
  rows.sort(function (a, b) { return b.tokens - a.tokens; });
  return [...new Set(rows.map(function (r) { return r.model; }))];
}

// Null when the text is not a Superset profile page.
export function parseProfileMarkdown(md: string): SupersetProfile | null {
  // Superset titles the page "<name or handle> (@<handle>)".
  const title = /^# (.+) \(@([a-z0-9-]+)\)\s*$/m.exec(md);
  const shown = title?.[1]?.trim();
  const handle = title?.[2];
  if (shown === undefined || handle === undefined) return null;
  const profile: SupersetProfile = {
    handle,
    achievements: section(md, "Achievements").flatMap(function (line) {
      const a = achievementFrom(line);
      return a === null ? [] : [a];
    }),
    models: modelsFrom(section(md, "Models")),
  };
  if (shown !== handle) profile.name = shown;
  const tier = /^- Tier: (.+)$/m.exec(md)?.[1]?.trim();
  if (tier !== undefined && tier !== "" && tier !== "Unranked") profile.tier = tier;
  return profile;
}

function plainName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Is this profile plausibly the signed-in hacker's? Superset puts the account's name in the ID token,
// and the profile page shows the same name. "unknown" when either side has no name to compare.
export function nameCheck(profileName: string | undefined, signInName: string | undefined): "match" | "mismatch" | "unknown" {
  if (profileName === undefined || signInName === undefined || plainName(signInName) === "") return "unknown";
  return plainName(profileName) === plainName(signInName) ? "match" : "mismatch";
}
