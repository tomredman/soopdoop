# soopdoop

Your Superset, with your crew in it.

soopdoop is a multiplayer layer on top of [Superset](https://superset.sh). Your own Superset stays the main screen. soopdoop adds the people and agents around you: who is online, what they want to show you, and what their agents already know.

Status: Phase 1, released as early versions (`CHANGELOG.md`). See `docs/plan.html` for the build order.

## Layout

| Path | What it is |
| --- | --- |
| `docs/spec.md` | The product spec: hackers, subsets, crews, knocks, eyes, jack in, the Operator, the tree, play, the tracker. |
| `docs/plan.html` | The build plan and the reasons behind it (what Superset already provides, the licence, phases). |
| `docs/spikes.md` | What was checked while building, what was not, and what it changed. |
| `install.sh` | The installer: puts the newest release in `~/.soopdoop/app` and runs its setup. |
| `bin/soopdoop` | The soopdoop command: `setup`, `status`, `open`, `logs`, `update`, `auto-update`, `uninstall`. |
| `scripts/release.ts` | Cuts a release (`bun run release`); see `RELEASING.md`. |
| `packages/convex/` | The backend: hackers, friendships, subsets (presence), knocks with scheduled expiry, sign in with Superset, linked Superset profiles, the Operator (`operator.ts`, `http.ts`, `lib/claude.ts`) and play (XP, ranks, the board). Tests with `convex-test`. |
| `apps/daemon/` | The subset daemon and the soopdoop CLI. Runs on a hacker's machine, installs lifecycle hooks into the coding harnesses, reports presence and routing summaries, and serves transcript reads to the Operator on request. Also the `ask_operator` MCP server (`src/mcp.ts`) and the app builder (`src/app.ts`). `setup` runs the services in the background. |
| `apps/hud/` | The soopdoop Mac app (Swift): a menu bar icon and the HUD, a floating panel shown over Superset. `setup` builds it on each Mac. |
| `apps/site/` | soopdoop.com: one static page on Cloudflare, with the eyes, a demo and a canned Operator. |
| `apps/rail/` | The local agent and the web rail. `serve.ts` holds the Superset sign-in and the live data for the Mac app (`src/agent.ts`, a WebSocket at `/app`), pairs this machine, and serves the web rail (`index.html` + `src/`). `prototype.html` is the clickable design. |
| `packages/operator/` | Notes on the Operator's design. The code is in `packages/convex` and `apps/daemon`. |
| `packages/plugin/` | A Superset plugin skill that tells agents to ask the Operator first. Not installed yet; the `ask_operator` tool's description does that job for now. |

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

soopdoop's own code is under the MIT License (`LICENSE`). That covers only this repository, not Superset.

## Install

You need a Mac with macOS 14 or newer, a Superset account, Claude Code, and Xcode's command line tools (`xcode-select --install`; git needs them too, so most Macs that code have them). The installer gets Bun if you do not have it.

```sh
curl -fsSL https://raw.githubusercontent.com/tomredman/soopdoop/main/install.sh | bash
```

It puts the newest release in `~/.soopdoop/app`, builds the soopdoop app (about a minute the first time) and starts it. The HUD appears on your screen and a soopdoop icon in the menu bar. In the HUD, sign in with Superset (your browser opens Superset's page once) and pick a handle. That is all. This Mac pairs itself, and your Claude Code sessions show up on their next prompt or tool call. Use your Superset handle as your soopdoop handle and your public Superset profile is linked too.

Without Xcode's command line tools there is no app: setup opens the web rail in your browser instead. It has your crew and knocks, but not the Operator box or the board. Claude Code's `ask_operator` tool works either way. Install the tools and run `soopdoop setup` again to get the app.

**If someone invited you**, paste the line from their message instead. It is the same line with `-s -- --invite <code>` at the end, and the invite makes you friends with whoever sent it.

**To invite someone:** menu bar icon → Invite someone new. It copies a message with that line. One invite per person; it works once, for 7 days. Two people who are both in already add each other by handle (HUD → Crew → + add a friend by handle).

**Updates install themselves.** A background job checks for a new release at login and every 6 hours and installs it, app included. The HUD says when a release is out if you turned that off. `soopdoop auto-update off` (or Settings → Updates) turns it off; `soopdoop update` installs the newest release now; `soopdoop update --to v0.1.0` moves to any release, also back. A failed update puts the previous version back by itself.

**What setup changes on your Mac:**

- Adds one soopdoop hook per Claude Code event to `~/.claude/settings.json`, beside Superset's hooks, which stay as they are. The first run saves your old file as `settings.json.before-soopdoop`.
- Builds the app into `~/Applications/soopdoop.app`. It is built from source on your Mac and signed for this Mac only, so macOS does not treat it as a downloaded app.
- Four LaunchAgents: `com.soopdoop.rail` (the local agent and the web rail, `http://127.0.0.1:47312/`) and `com.soopdoop.daemon` (127.0.0.1:47311) keep running and start when you log in; `com.soopdoop.hud` starts the app at login and again if it crashes; `com.soopdoop.updater` checks for releases. macOS may show a "Background Items Added" notice.
- Adds the `soopdoop` MCP server to Claude Code at user scope (`claude mcp add`), which is the `ask_operator` tool. Setup looks for `claude` on your PATH and where its installers put it (`~/.local/bin`, `~/.claude/local`, Homebrew). An update adds the tool if it is missing.
- `~/.soopdoop` holds the code (`app/`), this Mac's pairing (`config.json`), the app's Superset sign-in (`session.json`) and its key to the local agent (`app-token`), all readable only by you; settings; and the logs (`logs/`, including `reads.log`, below).
- A `soopdoop` command next to `bun`.

**What friends see:** whether you are online and how many agents run. Agent and folder names only if you turn them on (Settings). Your linked Superset profile: name, tier, achievements and the models you use, never token counts or cost. Your XP, rank, assists and questions on the board, unless you hide from it (Settings).

**What the Operator reads:** when a friend asks a question, the Operator may read the last part of one of your open agents' conversations to answer it (see The Operator, below). Friends never see the conversation itself, only the Operator's answer, which can quote it. Every read is listed in `~/.soopdoop/logs/reads.log` (which agent, which question id, how many characters; never the text). Agents in folders listed in `privateDirs` in `~/.soopdoop/config.json` are private: the Operator never reads or summarizes them, and friends never see them.

**Later:** `soopdoop status`, `soopdoop open` (shows the HUD), `soopdoop logs`, `soopdoop update`, `soopdoop uninstall` (removes the hooks, the background services, the app and the `ask_operator` tool; your pairing and the code stay until you delete `~/.soopdoop`).

Not yet: other harnesses than Claude Code (Codex and the rest do not show up), editing a routing summary, the app and background services on Linux or Windows (setup prints the two commands to run by hand there), and knocking from the HUD with anything but a title and a link.

## The app

A menu bar icon and the HUD. The HUD is a small floating panel that shows while Superset is in front and hides when you switch to another app. Clicking it does not take you out of Superset. Drag it anywhere; it stays there.

- **You:** your rank and XP, and how far to the next rank.
- **Knocks and friend requests:** a friend's knock shows with its countdown ring. Show me opens the link; Not now sends it back. It is gone when the ring runs out. Friend requests show under it with an Accept button.
- **Crew:** your friends with their lights (green working, blue idle, purple while the Operator reads their agent, grey offline), their agents and Superset profile (click a row), a knock button, the knocks you sent and what happened to them, and + add a friend by handle.
- **Operator:** ask your crew's agents a question, and see the answers (the wire).
- **Board:** you and your friends by XP. An assist (your agent answered a crewmate) is 10 XP, a question asked 1. Ranks: n00b, script kiddie (20), hacker (100), wizard (400), legend (1000).
- **This Mac:** your agents, private ones marked ◇, and what the Operator knows about each open one.

The menu bar icon shows the HUD any time, and has Focus (25, 50 or 90 minutes off the rail; knocks bounce), Invite someone new, Settings, and sign in or out. It turns into a bell while a knock waits.

**Settings** (menu bar → Settings…): when the HUD shows (with Superset, always, or only from the menu bar), its material (glass, frosted, dark, solid), background opacity, compact size, which sections show, and notifications. Also what friends see, hiding from the board, your Superset profile, and updates. The HUD stays on screen while Settings is open, so you see each change.

**Notifications:** when the HUD is hidden (the default), a knock, an answer to your question, or a friend request comes as a macOS notification. A knock's notification has Show me and Not now. Settings can make them always or never.

## The Operator

Ask a question your crew's agents probably already worked out, and get a short answer without reading the code yourself.

- **From the HUD:** type it in the Operator box.
- **From any Claude Code session:** setup gives Claude Code an `ask_operator` tool, so your agent can ask on its own. It waits up to 75 seconds; a later answer still shows in the HUD.

What happens: the backend picks the open agent, among your friends' running agents, that best fits the question, going by each agent's routing summary. Its owner's daemon sends the last part of that agent's conversation (at most 60,000 characters) once, for this one answer. Claude writes the answer from it, and the answer goes to you. The conversation itself is not stored; the backend keeps the question, the answer and the token counts. The owner gets an assist. If no agent fits, the Operator says so. A question that is not answered in 90 seconds expires.

A routing summary is one line per open agent, made on its owner's machine: workspace and branch, the first prompt (cut short) and the files it touched. The owner sees it in the HUD under This Mac.

The backend needs a Claude API key to answer: `npx convex env set ANTHROPIC_API_KEY <key> --prod` (Mr. Tom sets it). Without one, the Operator answers that it has no Claude API key yet.

## Develop

```sh
bun install
bun run convex     # Convex dev deployment (packages/convex); also runs codegen
bun run daemon     # the subset daemon, against the dev deployment
bun run rail       # the local agent and the web rail at http://127.0.0.1:47312/, with hot reload
bun test           # every package
bun run typecheck  # every package
bun run lint       # the Convex ESLint rules on packages/convex/convex
```

`bun run rail` and `bun run daemon` want ports 47312 and 47311, so stop the background services first: `soopdoop stop` (`soopdoop start` brings them back).

The app: `cd apps/hud && xcrun swift build && .build/debug/Soopdoop` runs it against whatever answers on port 47312. `.build/debug/Soopdoop --snapshot <dir>` draws the HUD with sample data into PNG files, with no server and no screen needed. The app reads the agent's state as JSON (`AppState` in `apps/rail/src/agent.ts`, `Models.swift` in the app); add fields, never rename or remove them, because an installed app can be older than its agent.

The Operator on your dev deployment: `npx convex env set ANTHROPIC_API_KEY <key>`, or `npx convex env set OPERATOR_FAKE 1` for a stand-in that routes by matching words and answers with the best-matching line, without calling Claude.

Two Convex deployments, both in team `vibes`, project `soopdoop`:

- **Production** (`fleet-skunk-723`): what installs use (`DEFAULT_CONVEX_URL` in `apps/rail/src/config.ts`). Only `bun run release` deploys to it.
- **Dev**: yours. `cd packages/convex && npx convex dev --once --configure existing --team vibes --project soopdoop` writes `.env.local`, and from then on the rail and daemon run from this checkout use it, and `npx convex dev` pushes to it.

Both trust Superset ID tokens for one OAuth client: `npx convex env set SUPERSET_CLIENT_ID <id from apps/rail/src/config.ts>` (add `--prod` for production; both are set). Commit `convex/_generated/` when it changes.

Releases: see `RELEASING.md`.

### What is verified

`bun test` covers the backend (friends, handles, presence views, knocks including the scheduled expiry, Superset profiles, the Operator from question to answer, routing summaries, XP), the daemon (state machine, hook, installer, pairing file, background service files, transcript slices, the MCP server, and a real `serve` that picks up a pairing), and the rail (sign-in pieces, pairing endpoint, invites, the app's sign-in and its `/app` socket). A real Superset sign-in, a real machine with live Claude Code sessions, and an Operator question from a real `ask_operator` call to a second machine's agent and back have been run end to end; see `docs/spikes.md` for what was and was not checked.
