# Project instructions

Plain English. No metaphor. Refer to the project owner as Mr. Tom.

## What this is

soopdoop is a multiplayer layer on top of Superset. Read `README.md`, then `docs/spec.md` for the product and `docs/plan.html` for the build order. The spec's vocabulary is the code's vocabulary: hacker, subset, crew, the Operator, knock, eyes, jack in, assist, ship, props.

## Boundaries

- Never import from the Superset repository or vendor its code. Use public surfaces only: harness lifecycle hooks, the Superset MCP server and SDK, Pages, Remote Access. This is a licence requirement (ELv2), not a preference.
- The daemon may send a transcript slice off the machine only for an agent the owner marked open, only to the Operator, only for one answer. Never persist transcript content server-side. Log every read (`~/.soopdoop/logs/reads.log`, sizes only). The one exception the spec allows is the routing summary: one line per open agent, at most 600 characters, built on the owner's machine and shown to the owner in the HUD.
- No purple before a relay exists. No token counts on personal or crew boards. Above the crew level, summaries describe work, never people.
- Every interruption has an expiry enforced by a scheduled function, not by the client.

## Code

- Bun workspace. TypeScript strict. `bun test` for tests, colocated as `thing.test.ts`.
- Convex backend in `packages/convex/convex/`. Read `packages/convex/convex/_generated/ai/guidelines.md` when it exists (run `npx convex codegen`). Public functions are session-authenticated: each one starts with a `require*` or `check*` call from `lib/auth.ts`. The rail and the daemon never call `internal*` functions.
- `bun run lint` runs the Convex ESLint plugin (https://docs.convex.dev/eslint) on `packages/convex/convex/`: the recommended rules with type information, plus `require-access-control` and `import-wrong-runtime`. Fix what it finds. Silence a finding only with a comment that says why.
- `convex/_generated/` is committed, so a fresh clone builds without Convex access. Commit it again after `npx convex dev` or `npx convex codegen` changes it.
- Start every new source file with two `// ABOUTME:` lines.
- Function declarations, not arrow constants, for top-level functions. `??` not `||`. No `as` outside tests. No non-null `!`.
- Commits: `type(scope): subject`. Release notes are built from these subjects, so write them for hackers.
- The Mac app is Swift in `apps/hud` (Swift package, macOS 14, no Xcode project). It shows state and sends actions; the agent in `apps/rail/src/agent.ts` does the work. Build with `xcrun swift build`; check the layout with `.build/debug/Soopdoop --snapshot <dir>` and look at the PNGs. Swift files start with the same two `// ABOUTME:` lines. SourceKit's "cannot find type" errors on single files are noise; `swift build` is the check.

## Releases

Installs run tagged releases, not `main`, and update themselves within 6 hours. Read `RELEASING.md` before changing the backend, the updater, setup, the app's state (`AppState`), or any path a LaunchAgent or Claude Code's settings point at. In short:

- Backend changes stay compatible with the previous release: add, do not rename or remove in the same release.
- Only `bun run release` deploys to the production Convex deployment. `npx convex dev` targets your dev deployment.
- Every version's `setup` keeps accepting `--no-open`, `--quiet` and `--keep-updater`.
- `AppState` only gains fields. An installed app can be older than its agent.

## Verification

Never claim something works unless you ran it against the exact target. Say what you did not check.
