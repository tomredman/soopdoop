# soopdoop

Your Superset, with your crew in it.

soopdoop is a multiplayer layer on top of [Superset](https://superset.sh). Your own Superset stays the main screen. soopdoop adds the people and agents around you: who is online, what they want to show you, and what their agents already know.

Status: Phase 1 in progress (see `docs/plan.html`). Nothing here is released.

## Layout

| Path | What it is |
| --- | --- |
| `docs/spec.md` | The product spec: hackers, subsets, crews, knocks, eyes, jack in, the Operator, the tree, play, the tracker. |
| `docs/plan.html` | The build plan and the reasons behind it (what Superset already provides, the licence, phases). |
| `docs/spikes.md` | What was checked while building, what was not, and what it changed. |
| `bin/soopdoop` | The soopdoop command: `setup` (the one command a new hacker runs), `status`, `logs`, `update`, `uninstall`. |
| `packages/convex/` | The backend: hackers, friendships, subsets (presence), knocks with scheduled expiry, sign in with Superset, linked Superset profiles. Tests with `convex-test`. |
| `apps/daemon/` | The subset daemon and the soopdoop CLI. Runs on a hacker's machine, installs lifecycle hooks into the coding harnesses, reports presence, serves transcript reads to the Operator on request. `setup` runs it and the rail as background services. |
| `apps/rail/` | The rail UI. `prototype.html` is the clickable design; `index.html` + `src/` is the Phase 1 app wired to Convex. |
| `packages/operator/` | The Operator: one coordinator per crew. Phase 2. |
| `packages/plugin/` | The Superset plugin: a skill and an MCP server so any agent can ask the Operator, knock, or request eyes. Phase 2. |

## Vocabulary

hacker (any user) · subset (one hacker's session and its agents; ∅ when empty) · crew (up to 8 subsets on one project) · crew leader (first inviter; runs the Operator) · the Operator · knock (30 s) · eyes (5 min) · jack in / jack out · assist · ship · props · the wire.

## Rules that do not bend

- Agents never talk to each other directly. Every question goes through the Operator.
- The Operator reads a transcript only to answer one question, then forgets it. It keeps a short routing summary per agent, which the owner can see and edit.
- Private agents never leave the machine.
- Purple means a relay in flight. Green means working. Blue means idle, open to knocks.
- Nothing stays on screen if the hacker ignores it. Every interruption expires.
- Above the crew: work only. No names, no counts.

## Superset and the licence

Superset is source-available under the Elastic License 2.0. soopdoop is a companion: our own daemon, backend, plugin and rail, running beside an unmodified Superset and talking to it through public surfaces only (harness hooks, the Superset MCP server and SDK, Pages, Remote Access). Nothing in this repository imports Superset internals or hosts Superset.

## Try it

You need a Mac, a Superset account, Claude Code, and read access to this repository (it is private; ask Mr. Tom). Setup installs Bun if you do not have it.

**If someone invited you**, paste the line from their message into Terminal. It looks like this:

```sh
[ -d ~/.soopdoop/app ] || git clone https://github.com/tomredman/soopdoop.git ~/.soopdoop/app; ~/.soopdoop/app/bin/soopdoop setup --invite <code>
```

Then, in the browser tab it opens, sign in with Superset and pick a handle. That is all. This Mac pairs itself, the invite makes you friends with whoever sent it, and your Claude Code sessions show up on their next prompt or tool call. Use your Superset handle as your soopdoop handle and your public Superset profile is linked too.

**To invite someone:** ⚙ → Invite someone new. It copies a message with that line. One invite per person; it works once, for 7 days. Two people who are both in already add each other by handle (⚙ → Add a friend).

**Without an invite:** run the same line without `--invite <code>`.

**What setup changes on your Mac:**

- Adds one soopdoop hook per Claude Code event to `~/.claude/settings.json`, beside Superset's hooks, which stay as they are. The first run saves your old file as `settings.json.before-soopdoop`.
- Two LaunchAgents keep soopdoop running and start it when you log in: `com.soopdoop.rail` (the rail, `http://127.0.0.1:47312/`) and `com.soopdoop.daemon` (127.0.0.1:47311). macOS may show a "Background Items Added" notice.
- `~/.soopdoop` holds the code (`app/`), this Mac's pairing (`config.json`, readable only by you) and the logs (`logs/`).
- A `soopdoop` command next to `bun`.

**What friends see:** whether you are online and how many agents run. Agent and folder names only if you turn them on (⚙). Never your prompts, code or transcripts. Your linked Superset profile: name, tier, achievements and the models you use, never token counts or cost. Folders listed in `privateDirs` in `~/.soopdoop/config.json` stay private.

**Later:** `soopdoop status`, `soopdoop logs`, `soopdoop update`, `soopdoop uninstall` (removes the hooks and the background services; your pairing and the code stay until you delete `~/.soopdoop`).

Not yet: other harnesses than Claude Code (Codex and the rest do not show up), and Linux or Windows background services (setup prints the two commands to run by hand).

## Develop

```sh
bun install
bun run convex     # Convex dev deployment (packages/convex); also runs codegen
bun run daemon     # the subset daemon, against the dev deployment
bun run rail       # the rail at http://127.0.0.1:47312/, with hot reload
bun test           # every package
bun run typecheck  # every package
bun run lint       # the Convex ESLint rules on packages/convex/convex
```

`bun run rail` and `bun run daemon` want ports 47312 and 47311, so stop the background services first: `bin/soopdoop stop` (`bin/soopdoop start` brings them back).

The rail and the daemon need no Convex access: they use the shared dev deployment (`apps/rail/src/config.ts`). Changing the backend does:

1. `cd packages/convex && npx convex dev --once --configure existing --team vibes --project soopdoop` writes `.env.local` for this checkout and pushes the functions.
2. The deployment trusts Superset ID tokens for one OAuth client: `npx convex env set SUPERSET_CLIENT_ID <id from apps/rail/src/config.ts>` (already set on the shared deployment).
3. Commit `convex/_generated/` when it changes.

### What is verified

`bun test` covers the backend (friends, handles, presence views, knocks including the scheduled expiry, Superset profiles), the daemon (state machine, hook, installer, pairing file, background service files, and a real `serve` that picks up a pairing), and the rail (sign-in pieces, pairing endpoint, invites). A real Superset sign-in and a real machine with live Claude Code sessions have both been run end to end; see `docs/spikes.md` for what was and was not checked.
