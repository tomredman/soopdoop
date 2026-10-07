// ABOUTME: Routing summaries as crewmates' agents may read them: secret-looking strings taken out, and the folder and
// ABOUTME: branch left off unless the owner shares folder names. Pure, so it is tested.

// Strings that look like secrets: API keys, tokens and long random strings. A prompt can carry one that was pasted in,
// and the summary quotes the start of the agent's last prompt.
const SECRETS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bsd_[a-f0-9]{32}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-fA-F0-9]{32,}\b/g,
  // Long strings that mix capitals, small letters and digits, the way generated keys do.
  /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}\b/g,
];

export function redactSecrets(text: string): string {
  return SECRETS.reduce(function (s, pattern) { return s.replace(pattern, "[secret]"); }, text);
}

// A summary is "<folder>@<branch> · "<last prompt>" · files: <files>", any part of it missing (the daemon's
// routingSummary). Without the folder and branch: the quoted prompt and the files, or whatever follows the first " · ".
export function withoutFolder(summary: string): string {
  const s = summary.trim();
  if (s.startsWith("\"") || s.startsWith("files: ")) return s;
  const at = s.indexOf(" · ");
  return at === -1 ? "" : s.slice(at + 3).trim();
}

// What a crewmate's agent is told about one of this hacker's agents.
export function summaryForCrew(summary: string, shareFolderNames: boolean): string {
  const clean = redactSecrets(summary);
  return (shareFolderNames ? clean : withoutFolder(clean)).trim();
}
