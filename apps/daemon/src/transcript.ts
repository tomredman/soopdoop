// ABOUTME: The old door to transcripts, kept so existing imports keep working: Claude Code's reader under its old name, and
// ABOUTME: everything in transcripts/index.ts. New code imports transcripts/index.ts, which reads Codex and Grok sessions too.
export { parseClaude as parseTranscript } from "./transcripts/claude";
export * from "./transcripts/index";
