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
| `bin/soopdoop` | The soopdoop command: `setup`, `status`, `open`, `logs`, `update`, `auto-update`, `fund`, `uninstall`. |
| `scripts/release.ts` | Cuts a release (`bun run release`); see `RELEASING.md`. |
| `packages/convex/` | The backend: hackers, friendships, subsets (presence), knocks with scheduled expiry, sign in with Superset, linked Superset profiles, the Operator (`operator.ts`, `http.ts`, `lib/claude.ts`) and play (XP, ranks, the board). Tests with `convex-test`. |
| `apps/daemon/` | The subset daemon and the soopdoop CLI. Runs on a hacker's machine, installs lifecycle hooks into the coding harnesses, reports presence and routing summaries, and asks its open agents the Operator's questions (`src/ask.ts`: a fork of the agent's session answers from what the agent knows). Also the soopdoop MCP server (`src/mcp.ts`: the `ask_operator` and `crew_status` tools) and the app builder (`src/app.ts`). `setup` runs the services in the background. |
| `apps/hud/` | The soopdoop Mac app (Swift): a menu bar icon, the HUD (a floating panel shown over Superset) and the Operator chat. `setup` builds it on each Mac. `icon/build.sh` makes its icon: `icon.py` renders the art in Blender (Cycles), `template.swift` fits it to Apple's macOS icon template, and `iconutil` packs `AppIcon.icns`. Run `sh apps/hud/icon/build.sh` (Blender 3.6; about 7 minutes on an M1 Max). |
| `apps/site/` | soopdoop.com: one static page on Cloudflare, with the eyes, a demo and a canned Operator. |
| `apps/rail/` | The local agent and the web rail. `serve.ts` holds the Superset sign-in and the live data for the Mac app (`src/agent.ts`, a WebSocket at `/app`), pairs this machine, and serves the web rail (`index.html` + `src/`). `prototype.html` is the clickable design. |
| `packages/operator/` | Notes on the Operator's design. The code is in `packages/convex` and `apps/daemon`. |
| `packages/plugin/` | The soopdoop skill (`skills/soopdoop/SKILL.md`), which tells agents when to ask the Operator. Setup copies it into `~/.claude/skills/soopdoop/`. |

## Vocabulary

hacker (any user) · subset (one hacker's session and its agents; ∅ when empty) · crew (up to 8 subsets on one project) · crew leader (first inviter; runs the Operator) · the Operator · knock (30 s) · eyes (5 min) · jack in / jack out · assist · ship · props · the wire.

## Rules that do not bend

- Agents never talk to each other directly. Every question goes through the Operator.
- The Operator never reads a transcript. It asks the agent that knows, and keeps only that agent's answer. It keeps a short routing summary per agent, which the owner can see and edit.
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

Without Xcode's command line tools there is no app: setup opens the web rail in your browser instead. It has your crew and knocks, but not the Operator's count or the board. Claude Code's `ask_operator` tool works either way. Install the tools and run `soopdoop setup` again to get the app.

**If someone invited you**, open their link (`soopdoop.com/invite#<code>`). It shows the same line with `-s -- --invite <code>` at the end, and the invite makes you friends with whoever sent it. Already running soopdoop? The page's Accept button does it.

**To invite someone:** HUD → Crew → + add a friend by handle, and type their soopdoop or Superset handle.

- Someone on soopdoop, by their soopdoop handle or the Superset handle they linked, gets a friend request.
- Anyone else gets an invite, and its message goes on your clipboard: one line with the link, for Slack or anywhere. When Superset has a public profile for that handle, the message greets them by name, and the invite works even without the link: they join your crew as soon as they sign in to soopdoop and link that Superset profile (it happens by itself when they pick their Superset handle as their soopdoop handle).
- Menu bar icon → Invite someone new makes a link for anyone, no handle needed.

An invite works once, for 7 days.

**Updates install themselves.** A background job checks for a new release at login and every 6 hours and installs it, app included. The HUD says when a release is out if you turned that off. `soopdoop auto-update off` (or Settings → Updates) turns it off; `soopdoop update` installs the newest release now; `soopdoop update --to v0.1.0` moves to any release, also back. A failed update puts the previous version back by itself.

**What setup changes on your Mac:**

- Adds one soopdoop hook per Claude Code event to `~/.claude/settings.json`, beside Superset's hooks, which stay as they are. The first run saves your old file as `settings.json.before-soopdoop`.
- Builds the app into `~/Applications/soopdoop.app`. It is built from source on your Mac and signed for this Mac only, so macOS does not treat it as a downloaded app.
- Four LaunchAgents: `com.soopdoop.rail` (the local agent and the web rail, `http://127.0.0.1:47312/`) and `com.soopdoop.daemon` (127.0.0.1:47311) keep running and start when you log in; `com.soopdoop.hud` starts the app at login and again if it crashes; `com.soopdoop.updater` checks for releases. macOS may show a "Background Items Added" notice.
- Adds the `soopdoop` MCP server to Claude Code at user scope (`claude mcp add`), which has the `ask_operator` and `crew_status` tools. Setup looks for `claude` on your PATH and where its installers put it (`~/.local/bin`, `~/.claude/local`, Homebrew). An update adds the server if it is missing.
- Adds the soopdoop skill to Claude Code (`~/.claude/skills/soopdoop/SKILL.md`). It tells your agents when to ask the Operator: before a long search of code a crewmate built or is changing, or instead of stopping to ask you about a crewmate's work. Every update writes it again.
- `~/.soopdoop` holds the code (`app/`), this Mac's pairing (`config.json`), the app's Superset sign-in (`session.json`) and its key to the local agent (`app-token`), all readable only by you; settings; and the logs (`logs/`, including `reads.log`, below).
- A `soopdoop` command next to `bun`.

**What friends see:** whether you are online and how many agents run. Agent and folder names only if you turn them on (Settings). Your linked Superset profile: name, tier, achievements and the models you use, never token counts or cost. Your XP, rank, assists and questions on the board, unless you hide from it (Settings).

**What the Operator asks your agents:** when a friend's agent asks a question that one of your open agents knows about, your daemon asks that agent on your Mac and sends back only its short answer (see The Operator, below). The question is answered by a copy of the agent's session that has no tools and is not saved, so your agent's own session never changes. Friends never see the conversation, only the answer, which can quote it. The answer is written with your Claude Code account, so it uses your plan or costs you about what reading the agent's conversation once costs. Every question is listed in `~/.soopdoop/logs/reads.log` (which agent, which question id, who asked, how long the answer was, how many tokens it read and what it cost; never the question or the answer). Private projects never leave your Mac: the Operator never asks or summarizes their agents, and friends never see them. Turn one private with its switch under This Mac in the HUD (Settings shows that section), or list folders in `privateDirs` in `~/.soopdoop/config.json`. A folder covers its whole git repository, so every Superset workspace and worktree of that project.

**The anti-hijacking fund:** your agents answer crewmates' questions only within a budget, checked on your Mac before each answer: $5 in any 24 hours, and one crewmate can use at most half of it. When it is spent, the asker reads that your agents have spent today's answering fund, and nothing is read. `soopdoop fund` shows what was spent in the last 24 hours and by whom; `soopdoop fund 10 0.5` sets $10 a day, half of it per crewmate; `soopdoop fund 0` turns answering off. The check runs on the Mac that pays, so neither a crewmate nor the backend can get around it. The Operator also turns away questions that ask an agent to do work (write, change, fix or review code, documents or plans) before any agent is read.

**Later:** `soopdoop status`, `soopdoop open` (shows the HUD), `soopdoop logs`, `soopdoop update`, `soopdoop fund`, `soopdoop uninstall` (removes the hooks, the background services, the app, the `ask_operator` tool and the skill; your pairing and the code stay until you delete `~/.soopdoop`).

Not yet: other harnesses than Claude Code (Codex and the rest do not show up), editing a routing summary, the app and background services on Linux or Windows (setup prints the two commands to run by hand there), and knocking from the HUD with anything but a title and a link.

## The app

A menu bar icon and the HUD. The HUD is a small floating panel that shows while Superset is in front and hides when you switch to another app. Clicking it does not take you out of Superset. Drag it anywhere; it stays there.

- **You:** your rank and XP, and how far to the next rank.
- **Knocks and friend requests:** a friend's knock shows with its countdown ring. Show me opens the link; Not now sends it back. It is gone when the ring runs out. Friend requests show under it with an Accept button.
- **Crew:** your friends by @handle (their real names too, if you turn that on in Settings) with their lights (green working, blue idle, purple while their agent answers the Operator, grey offline), their agents and Superset profile (click a row), a flick button (the hand), a superflick button (⚡, when you have one) and a knock button, the knocks you sent and what happened to them, and + add a friend by handle, which invites them when they are not on soopdoop yet. The header shows your progress to the next superflick.
- **Flicks:** a flick is a poke, with a risk. Your friend sees "@ada flicked you" with a catch! button for 10 seconds: catch it in time and they take up to 5 XP from you (never more than you have). After that it can only be flicked back, and each flick back adds one to the rally. You can flick someone again once they flick back. A flick nobody answers goes away after 10 minutes; focus mode bounces it. When the HUD is hidden, the notification has a Catch! button.
- **Superflicks:** every 5 flicks in a row that nobody catches earn a superflick (being caught starts the count over). Use it on any friend, focus mode or not: it takes up to 10 XP from them, and nobody catches a superflick.
- **Operator:** one line: how many questions the Operator answered today, for your agents and from them, and a chat button that opens the Operator chat (see The Operator, below). Click the title to open it: its last 3 moves, newest first, such as who it is asking right now, which agent answered and how many tokens it read (ephemerally: nothing it read is saved), and what your agents answered for friends.
- **Board:** you and your friends by XP. An assist (your agent answered a crewmate) is 10 XP, a question asked 1, every flick you send 1 and every knock you send 2, whatever happens to them; caught flicks and superflicks move XP from one friend to another. Ranks: n00b, script kiddie (20), hacker (100), wizard (400), legend (1000).
- **This Mac** (off until you turn it on in Settings): your agents, private ones marked ◇, what the Operator knows about each open one, and a private switch for each, which keeps that agent's whole project private. Click the title to fold it to one line (the machine and how many agents).

The menu bar icon shows the HUD any time, and has Chat with the Operator…, Focus (25, 50 or 90 minutes off the rail; knocks bounce), Invite someone new, Settings, and sign in or out. It turns into a bell while a knock waits.

**Settings** (menu bar → Settings…): when the HUD shows (with Superset, always, or only from the menu bar), its material (glass, frosted, dark, solid), background opacity, compact size, real names next to handles (off: just the @handle), which sections show and in what order (the arrows), and notifications. Also what friends see, hiding from the board, your Superset profile, and updates. The HUD stays on screen while Settings is open, so you see each change.

**Notifications:** when the HUD is hidden (the default), a knock, an answer to your question, or a friend request comes as a macOS notification. A knock's notification has Show me and Not now. Settings can make them always or never.

## The Operator

Your agents ask the questions your crew's agents probably already worked out, and get a short answer without reading the code themselves.

- **From any Claude Code session:** setup gives Claude Code the `ask_operator` tool and the soopdoop skill, which tells the agent when to use it. The tool waits up to 75 seconds; a later answer still shows in the HUD. A question about one crewmate names them by @handle, and `crew_status` lists the handles. A first name, the start of a handle or the Superset handle they linked finds them too, when it fits only one crewmate ("@ada" finds @adalovelace). A name that fits nobody, or more than one crewmate, comes back with the crew's handles. "What is @jimmy working on?" is answered by the Operator from what each of Jimmy's open agents is working on (their routing summaries), so no agent is asked and it costs Jimmy nothing. So is a who-question: ask your agent "who should I ask about contact enrichment?" and it asks the Operator right away, which answers like a teammate: "Ada (@adalovelace) has an agent on enrichment right now. What would you like to know?" Your answer goes to Ada's agent, and its answer comes back. A question that needs more than the summaries say (files, details, whether something is still true) goes straight to the agent.
- **In the Operator chat** (HUD → Operator → chat, or menu bar → Chat with the Operator…): talk to it. It answers small talk and crew questions itself (who is around, who works on what, from the routing summaries), and asks a crewmate's agent when the answer needs one, rewriting a follow-up so it stands alone. Chatting with the Operator itself earns no XP; a question it passes to the crew counts as one asked.

What happens: the backend picks the open agent, among your friends' running agents, that best fits the question, going by each agent's routing summary. Its owner's daemon asks that agent the question: it runs `claude -p --resume <session> --fork-session --no-session-persistence --safe-mode --tools ""`, a copy of the agent's session that answers from everything the agent knows, with no tools, hooks or MCP servers, saved nowhere. The agent's own session is not touched, even while it is working. Only the answer leaves the owner's Mac, and the answer goes to you. The backend keeps the question, the answer and the token counts. The owner gets an assist. If no agent fits, or the agent says it does not know, the Operator says so. A question that is not answered in 90 seconds expires.

The answer is written with the owner's Claude Code account and the agent's own model, and it reads the agent's whole conversation. The first question writes that conversation to the prompt cache; another question to the same agent within 5 minutes reads it back for a small part of the price. Measured on Claude Opus 5.5: a 72,000-token session cost $0.39 for a first question and $0.04 for the next one; a first question to a 433,000-token session costs about $2.20. Claude Code's own `total_cost_usd` also counts everything the session spent before, so the daemon works the cost out from the copy's own usage, at the model's API prices.

A routing summary is one line per open agent, made on its owner's machine: workspace and branch, the first prompt (cut short) and the files it touched. The owner sees it in the HUD under This Mac.

The backend needs a Claude API key to route questions: `npx convex env set ANTHROPIC_API_KEY <key> --prod` (Mr. Tom sets it). Without one, the Operator answers that it has no Claude API key yet.

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

The Operator on your dev deployment: `npx convex env set ANTHROPIC_API_KEY <key>`, or `npx convex env set OPERATOR_FAKE 1` for a stand-in that routes by matching words, without calling Claude. The answers still come from the agents themselves, through `claude` on their owners' machines.

Two Convex deployments, both in team `vibes`, project `soopdoop`:

- **Production** (`fleet-skunk-723`): what installs use (`DEFAULT_CONVEX_URL` in `apps/rail/src/config.ts`). Only `bun run release` deploys to it.
- **Dev**: yours. `cd packages/convex && npx convex dev --once --configure existing --team vibes --project soopdoop` writes `.env.local`, and from then on the rail and daemon run from this checkout use it, and `npx convex dev` pushes to it.

Both trust Superset ID tokens for one OAuth client: `npx convex env set SUPERSET_CLIENT_ID <id from apps/rail/src/config.ts>` (add `--prod` for production; both are set). Commit `convex/_generated/` when it changes.

Releases: see `RELEASING.md`.

### What is verified

`bun test` covers the backend (friends, handles, presence views, invites by handle, knocks including the scheduled expiry, flicks, Superset profiles, the Operator from question to answer, routing summaries, XP), the daemon (state machine, hook, installer, pairing file, background service files, asking an agent, the skill, the MCP server, and a real `serve` that picks up a pairing), and the rail (sign-in pieces, pairing endpoint, invites, the app's sign-in and its `/app` socket). A real Superset sign-in, a real machine with live Claude Code sessions, and an Operator question from a real `ask_operator` call to a second machine's agent and back have been run end to end; see `docs/spikes.md` for what was and was not checked.
