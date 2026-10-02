# Project instructions

Plain English. No metaphor. Refer to the project owner as Mr. Tom.

## What this is

soopdoop is a multiplayer layer on top of Superset. Read `README.md`, then `docs/spec.md` for the product and `docs/plan.html` for the build order. The spec's vocabulary is the code's vocabulary: hacker, subset, crew, the Operator, knock, eyes, jack in, assist, ship, props.

## Boundaries

- Never import from the Superset repository or vendor its code. Use public surfaces only: harness lifecycle hooks, the Superset MCP server and SDK, Pages, Remote Access. This is a licence requirement (ELv2), not a preference.
- The daemon may send a transcript slice off the machine only for an agent the owner marked open, only to the Operator, only for one answer. Never persist transcript content server-side. Log every read.
- No purple before a relay exists. No token counts on personal or crew boards. Above the crew level, summaries describe work, never people.
- Every interruption has an expiry enforced by a scheduled function, not by the client.

## Code

- Bun workspace. TypeScript strict. `bun test` for tests, colocated as `thing.test.ts`.
- Convex backend in `packages/convex/convex/`. Read `packages/convex/convex/_generated/ai/guidelines.md` when it exists (run `npx convex codegen`). Public functions are session-authenticated: each one starts with a `require*` or `check*` call from `lib/auth.ts`. The rail and the daemon never call `internal*` functions.
- `bun run lint` runs the Convex ESLint plugin (https://docs.convex.dev/eslint) on `packages/convex/convex/`: the recommended rules with type information, plus `require-access-control` and `import-wrong-runtime`. Fix what it finds. Silence a finding only with a comment that says why.
- `convex/_generated/` is committed, so a fresh clone builds without Convex access. Commit it again after `npx convex dev` or `npx convex codegen` changes it.
- Start every new source file with two `// ABOUTME:` lines.
- Function declarations, not arrow constants, for top-level functions. `??` not `||`. No `as` outside tests. No non-null `!`.
- Commits: `type(scope): subject`.

## Verification

Never claim something works unless you ran it against the exact target. Say what you did not check.
