// ABOUTME: Takes strings that look like secrets (API keys, tokens, long random strings) out of text before it leaves this Mac.
// ABOUTME: The same patterns as the backend's packages/convex/convex/lib/summaries.ts; a test keeps the two in step.

// Strings that look like secrets: API keys, tokens and long random strings. A prompt can carry one that was pasted in.
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
