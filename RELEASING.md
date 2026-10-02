# Releasing

Installs run releases, not `main`. A release is a tag `vX.Y.Z` on `main`, a GitHub release with notes, and the backend deployed to the production Convex deployment. Installs pick a new release up within 6 hours (the updater job), or at once with `soopdoop update`.

## Cut a release

From a checkout of `main` that matches GitHub, with `packages/convex/.env.local` set up (`npx convex dev --once --configure existing --team vibes --project soopdoop`) and `gh` signed in:

```sh
bun run release patch --dry-run   # shows the version and the notes; changes nothing
bun run release patch             # or minor, or major
```

The script stops at the first problem. In order, it:

1. Checks that HEAD is `origin/main` and nothing is uncommitted.
2. Runs `bun test`, `bun run typecheck`, `bun run lint`, builds the Mac app (`apps/hud`, because every install builds it from the tag), and checks that `convex/_generated` is committed and current.
3. Deploys the backend to production (`npx convex deploy`). This comes before the tag, so no install ever runs a tag whose functions are missing.
4. Bumps the version in the root `package.json`, adds the notes to `CHANGELOG.md` (from the commit subjects since the last tag, grouped by `feat`, `fix`, `docs` and the rest), commits `chore(release): vX.Y.Z`, tags it, and pushes both.
5. Publishes the GitHub release with the notes and the install line.

Pick the bump by what changed for hackers: `patch` for fixes, `minor` for new things, `major` for anything that needs them to act. `RELEASE_TRAILERS="Co-Authored-By: …"` adds trailer lines to the release commit.

## Rules that keep updates safe

- **The backend stays compatible with the previous release.** Installs take up to 6 hours to update, and a hacker can turn auto-update off. Add functions, arguments (optional) and fields; do not rename or remove them in the same release. Remove them a release later.
- **Only the release script deploys to production.** `npx convex dev` deploys to your own dev deployment.
- **Every version's `setup` keeps accepting `--no-open`, `--quiet` and `--keep-updater`.** The updater of the old version runs the new version's setup with them.
- **Paths that other programs hold stay put:** `apps/daemon/src/hook.ts` (Claude Code's settings point at it), `apps/daemon/src/mcp.ts` (Claude Code's MCP config points at it; an update registers the tool only when it is missing, so it never rewrites the path), `apps/daemon/src/cli.ts` and `apps/rail/serve.ts` (the LaunchAgents point at them), and the app at `~/Applications/soopdoop.app/Contents/MacOS/Soopdoop` (the `com.soopdoop.hud` LaunchAgent points at it). If one has to move, keep a file at the old path that forwards to the new one for at least one release.
- **The app and its agent can be different versions.** Setup rebuilds the app on every update, but a build can fail (no Xcode tools, an old Swift), and then the old app keeps running against the new agent. So the state the agent sends (`AppState` in `apps/rail/src/agent.ts`) only gains fields: never rename or remove one, and keep accepting every action name the app sends. The app decodes leniently: a missing field takes its default and an unknown one is ignored.
- **Setup works without the app.** If the app does not build, setup says why, skips the `com.soopdoop.hud` LaunchAgent, and carries on; it must not fail the update.

## When a release is bad

Cut a fixed release; installs update within 6 hours. One machine can go back at once: `soopdoop update --to vX.Y.Z`. If an update fails on a machine (the new version does not install or start), that machine puts the previous version back by itself and the rail shows why.
