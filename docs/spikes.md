# Spikes and findings

What was checked while building Phase 1, and what was not. Dates are when the check was made.

## Sign in with Superset (29 Sep 2026)

Superset is a full OpenID Connect provider. `https://api.superset.sh/.well-known/openid-configuration` lists the authorize and token endpoints, a JWKS (`/api/auth/jwks`, RS256), PKCE S256, refresh tokens with `offline_access`, public clients (`token_endpoint_auth_method: none`), and RFC 7591 dynamic client registration. `https://superset.sh/auth.md` documents the flow for agents.

Done: registered a public client named `soopdoop` with redirect `http://127.0.0.1:47312/` (Superset rewrote `localhost` to `127.0.0.1`). The client id is in `apps/rail/src/config.ts` and in the deployment env var `SUPERSET_CLIENT_ID`; `packages/convex/convex/auth.config.ts` trusts ID tokens from `https://api.superset.sh` whose `aud` is that client.

First real sign-in (1 Oct 2026): the authorize step works. Mr. Tom signed in at Superset and was sent back to the rail with a code. The code exchange then failed in the browser with "Failed to fetch": Superset's token endpoint answers without any `Access-Control-Allow-Origin` header (checked with a POST carrying `Origin: http://127.0.0.1:47312`, and an OPTIONS preflight, both without CORS headers), so a page on another origin can never read its reply. The userinfo endpoint does send CORS headers; the token endpoint does not.

Fix: the rail's own server forwards the exchange (`apps/rail/src/token-proxy.ts`, route `POST /oauth/token`). Checked against the real endpoint: a made-up code sent from the page comes back as Superset's own `invalid_grant · invalid code`, and a made-up refresh token as `invalid_grant · session not found`. Consequence for shipping: the desktop shell must make this call from its own process; a static page cannot sign in.

Verified (1 Oct 2026, after the fix): Mr. Tom signed in end to end. Superset's token response carried an ID token, Convex accepted it with `auth.config.ts` as written, and `claimHandle` created hacker `tom` whose `supersetUserId` is Superset's user id (a UUID). The rail then paired machine `mbp16`.

Open question (29 Sep): Superset's docs say a registration "is anonymous until the user claims it via browser consent". If only one user can claim a client, every rail install must register its own client, and Convex must stop pinning `aud` (custom JWT without `applicationID`).

Answered from the code (2 Oct 2026), not yet seen live: one client serves every Superset user. Superset's `packages/auth/src/server.ts` uses `@better-auth/oauth-provider` 1.6.22 with `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration`. In that version, `/oauth2/authorize` checks that the client exists and is enabled, the redirect URI, scopes and PKCE, then looks for this user's consent (an `oauthConsent` row per client, user and organization). It never compares the client's owner with the signed-in user, and neither does the consent step or the code exchange. The ID token's `aud` is the client id and it carries `name` (with the `profile` scope), so `auth.config.ts` stays as it is. The "claim" in the docs is the per-user consent. The first colleague's sign-in is the live check.

## Superset profiles (2 Oct 2026)

Superset publishes a markdown version of every public leaderboard profile at `https://superset.sh/md/user/<handle>` (Superset's `apps/marketing/src/lib/profile-markdown.ts` renders it; cached for an hour; `404` with a "Not found" page for an unknown handle; handles are lowercased). It has the name, rank, tier, all-time tokens, cost and sessions, how the tier was scored, achievements, milestones, active days, models with tokens and cost, and a token breakdown. The page says it is "published voluntarily by the account holder". soopdoop keeps name, tier, achievements and model names (`packages/convex/convex/lib/supersetProfile.ts`) and drops the rest, because AGENTS.md keeps token counts off personal and crew boards.

There is no public way to learn the handle of a signed-in user: the ID token has `sub`, `name`, `email` and `picture`, and the MCP server has no profile tool. So a hacker links a handle, and the backend checks that the page's name matches the `name` in their Superset sign-in. Superset's handle rule (`^[a-z0-9]+(-[a-z0-9]+)*$`, 2 to 39 characters, its `handles` table) is soopdoop's, so the rail tries the soopdoop handle right after it is picked and links it only on a real name match. The leaderboard also has a tRPC API that Superset's website reads; it is not a published surface, so soopdoop does not use it.

Checked: the parser against a live page by hand (all four achievements and seven models, `unknown` skipped), and in tests against a made-up page in the exact format. Not checked: a refresh run by the cron on the deployment.

## Background services (2 Oct 2026)

`bin/soopdoop setup` runs the rail and the daemon as macOS LaunchAgents (`RunAtLoad`, `KeepAlive`), so they survive closing a terminal, a crash and a restart, and no app can stop them on a timer (the Claude app did that to the rail twice). They run with an absolute path to bun because launchd does not read the shell's PATH. Generated plists pass `plutil -lint`. With `SOOPDOOP_SERVICE=1` the rail runs Bun's production mode: the page and an 88 KB bundle were served, `/local` and `/local/pair` answered as designed over real HTTP. The daemon now starts unpaired and picks up the pairing file within a second (tested by running `serve` for real).

Not built: background services on Linux and Windows. Setup prints the two commands to run by hand there.

## Releases and updates (2 Oct 2026)

Installs are git checkouts of a release tag in `~/.soopdoop/app`; `install.sh` picks the newest `vX.Y.Z` tag. The updater LaunchAgent (`com.soopdoop.updater`, at login and every 6 hours) reads the tags with `git ls-remote` (no GitHub API, no rate limit), and an update is: check out the tag, `bun install`, then run the new version's own `setup --no-open --quiet --keep-updater`, so hooks and LaunchAgents match the new code. Any failure checks the previous commit out again, installs and sets it up, and records why in `~/.soopdoop/update.json`. A lock file keeps it to one update at a time. The updater cannot reload its own LaunchAgent while it runs; setup rewrites its plist and launchd reads it at the next load.

Production Convex deployment `fleet-skunk-723` holds released backends; personal dev deployments hold work in progress. The rail treats a pairing with another deployment as unpaired and pairs again, which is how existing machines moved from dev to production.

Checked in tests with real git against a local bare repository: picking the newest release, moving to it, undoing a failed setup, refusing local changes, the lock and stale-lock cleanup. Generated plists pass `plutil -lint`.

## The Mac app (2 Oct 2026)

Mr. Tom asked for an app instead of a web page left open in the background: a menu bar app with a HUD that shows while Superset is in front, a look the hacker can change (material, opacity), and the crew, the board, knocks and the Operator in it.

It is native Swift (SwiftUI and AppKit) in `apps/hud`: a floating `NSPanel` that does not activate the app, with an `NSVisualEffectView` behind the content, shown and hidden on `NSWorkspace` app-activation notices. Superset's bundle id is `com.superset.desktop` (checked with `lsappinfo` on Mr. Tom's Mac while Superset was in front).

`setup` builds it on each Mac from the release's source (`xcrun swift build -c release`), wraps it in a bundle with `LSUIElement` (no Dock icon) and signs it ad hoc. No binary is downloaded, so there is no notarization step and no Gatekeeper prompt. The cost is that each Mac needs Xcode's command line tools; without them setup says so and opens the web rail instead. The release script builds the app before it tags, so a tag that does not compile is never published.

The app holds no tokens and talks to no server but this Mac's agent. The rail's server (`apps/rail/serve.ts`) runs the agent (`src/agent.ts`): it holds the Superset sign-in (`~/.soopdoop/session.json`, mode 600) and the Convex subscriptions, and pushes the state to the app over `ws://127.0.0.1:47312/app`. That socket needs the token in `~/.soopdoop/app-token` (mode 600) and refuses any request that carries a browser `Origin`, so a web page cannot use it.

The app signs in with a loopback flow (RFC 8252) on `127.0.0.1:47313`, so it never collides with the web rail's own sign-in on 47312. Checked against Superset's live authorize endpoint, without signing in: the registered `http://127.0.0.1:47312/` and the app's `http://127.0.0.1:47313/` both go on to Superset's sign-in page, while `http://127.0.0.1:47313/other` and `https://example.com/` come back as `invalid_redirect`. So Superset ignores the port of a loopback redirect and still checks the host and the path.

Checked: debug and release builds; `Soopdoop --snapshot` drew the three screens (signed out, pick a handle, a full HUD with sample data) and they were looked at; a bundle built by `buildApp` passes `codesign --verify`; the agent's sign-in pieces, `/app` socket and actions are tested (`apps/rail/src/app-backend.test.ts`).

## The Operator (2 Oct 2026)

A question comes from the `ask_operator` tool (`operator.ask`, with the daemon's token) or from the HUD (`operator.askAsHacker`). The backend stores it (500 characters at most, 6 a minute per hacker) and schedules `route`, which lists the asker's friends' live, open agents with their routing summaries and asks Claude (Opus 5.5, low effort) to pick one or none. The target's daemon follows `operator.readsFor`, which tells it only a relay id and an agent id. The daemon reads the tail of that agent's transcript, cuts a slice of at most 60,000 characters of conversation, logs the read (`~/.soopdoop/logs/reads.log`, sizes only), and posts the slice once to `POST /operator/answer` on the deployment's `.convex.site`. That HTTP action asks Claude (medium effort) for the answer and stores only the answer and the token counts; the slice is never written. A relay that is not finished in 90 seconds expires through a scheduled function. The Claude calls use server-side fallbacks (`fallbacks: "default"`), so an overloaded model falls back to another instead of failing the question.

A routing summary is built on the owner's machine after each turn: `workspace@branch · "first prompt" · files: …`, at most 600 characters, only for open agents. It is deleted when the agent closes or turns private.

`OPERATOR_FAKE=1` on a dev deployment swaps Claude for a stand-in that routes by shared words and answers with the best-matching `assistant:` line, so the whole path can be tested without an API key.

Checked end to end on the dev deployment with the stand-in: two test hackers who are friends, each with a paired daemon. The second ran a real `serve` with a Claude Code session reported through the real hook and a transcript on disk. A real `ask_operator` call over the MCP server's stdio, as the first hacker, came back in about 2 seconds with the answer from the second hacker's agent, and the second daemon's `reads.log` recorded the read (244 characters). `bun test` covers the backend side (`operator.test.ts`), the transcript slicing and the MCP server.

Not checked: answers from the real Claude API (no key was set on any deployment while building), routing among many agents, and the Operator on production.

## Asking the agent instead of reading a slice (5 Oct 2026)

The daemon no longer sends a slice of the conversation. `operator.readsFor` now gives the daemon the question too, and the daemon asks the agent itself (`apps/daemon/src/ask.ts`): `claude -p --resume <session id> --fork-session --no-session-persistence --safe-mode --tools "" --effort low --output-format json <question and instructions>`. It runs in the agent's folder, with the session's own `CLAUDE_CONFIG_DIR` (worked out from the transcript path), and with the real `claude`, not Superset's wrapper. Only the agent's answer (cut at 2,000 characters) and the tokens it read go to `POST /operator/answer`. An agent that does not know answers `NOT_FOUND`, which becomes "It has not worked on this." The backend still takes a slice from older daemons.

Checked with Claude Code 2.1.289:

- A fork found its session from any folder, answered from it, and wrote no transcript. The original transcript did not change, and the fork never showed up as an agent (safe mode skips hooks).
- A history full of tool calls works with `--tools ""`.
- Forking a session in the middle of a turn (this session: 157,000 tokens on Opus 5.5, with a tool call running) answered correctly, including what the session was doing at that moment, in 6 seconds, for $1.26 at API prices. The fork's tools differ from the live session's, so it reads nothing from the live session's prompt cache, and two questions in a row to the same small session cost the same.
- It runs in a launchd-like environment (`env -i` with only HOME, USER and a short PATH): Claude Code reads its sign-in from the keychain.
- A session that does not exist: exit 1, nothing on stdout, "No conversation found with session ID: …" on stderr. The asker gets that reason.
- End to end on the dev deployment with the routing stand-in: two test hackers (@t-ask-1005 and @t-ans-1005), a second daemon from this branch on port 47398 with a real Claude Code session reported through `/hook`, and a real `ask_operator` call over the MCP server's stdio. The answer came back in 5 seconds from the agent's own fork. The relay stored 7,030 tokens read and 44 sent, and `reads.log` recorded sizes and cost only. A question the agent could not answer came back as "did not know", and the log still recorded what that read cost.
- The HUD: `Soopdoop --snapshot` drew the new Operator section (one line, "2 answered today", no Ask box), and it was looked at.

Not checked: production; two different Macs; an older Claude Code without `--safe-mode`, `--tools` or `--no-session-persistence` (the daemon passes the error on to the asker); a session kept in another `CLAUDE_CONFIG_DIR` (unit-tested only); sessions near their context limit or the 70-second timeout.

## Invites by handle, and flicks (5 Oct 2026)

Adding a friend by handle (`friends.addByHandle`, an action) asks someone on soopdoop, found by their soopdoop handle or by the Superset handle they linked. Anyone else gets an invite. When Superset has a public profile for the handle (`superset.sh/md/user/<handle>`), the invite stores that handle and name, and `superset.save` redeems open invites for a handle when someone links it; linking already checks that the profile's name matches the Superset sign-in, so nobody can take someone else's invite by typing their handle. If Superset cannot be read, a plain invite still goes out. The app copies a one-line message with `soopdoop.com/invite#<code>`; the code sits in the fragment, so it never reaches Cloudflare. The page (`apps/site/invite.html`) fills in the install line and an Accept link to the local rail.

A flick is a poke between friends: open until flicked back or a scheduled function expires it after 10 minutes, at most one open flick per sender per friend, and each flick back adds one to the rally. Focus mode bounces it.

Checked on the dev deployment: adding a friend already on soopdoop asked them; adding `@vlad` found his real public Superset profile and made an invite naming him; adding a handle on neither made a plain invite, and a new test hacker redeemed it and joined the crew. A flick rally between two test hackers went 1, then "Wait for … to flick back", then 2, and the last flick, left alone, was gone 10 minutes later through its scheduled function. `bun test` covers the same paths with a faked Superset, plus linking a profile redeeming an invite and a stranger failing to. The invite page was built and drawn in headless Chrome with a code; the HUD's snapshot mode drew the flick row, the hand buttons and the knock composer at 300 and 260 points wide (the composer's buttons wrapped there before).

The Operator's tests ask questions, which schedule `route` at 0 ms. Those timers never fired during the tests, because the tests only await database calls; they fired when the next test file started and failed it. That file used to be last, so nobody saw it. `settleScheduled()` (testing.helpers.ts) now runs them at the end of each Operator test.

Not checked: the invite page on soopdoop.com (not deployed yet), the redeem-on-link path against a real Superset sign-in, and the macOS notification for a flick.

## Catching flicks, superflicks, the private switch (5 Oct 2026)

A flick can be caught for 10 seconds (`flicks.catchFlick`); catching takes up to 5 XP from the flicker, never more than they have. A scheduled function closes the window (`closeCatch`, which sets `safe`), and every 5 flicks in a row that closed safe earn a superflick: `flicks.superflick` takes up to 10 XP from any friend, focus or not, and cannot be caught. XP stays counted from records: `play.ts` adds what a hacker caught or superflicked and takes away what was taken from them. The streak is ordered by `_creationTime`, because two flicks can share a millisecond.

The HUD's private switch goes app → local agent (`setPrivate`) → daemon (`POST /private`, refused with an Origin header, like `/hook`). The daemon keeps each agent's git repository (`git rev-parse --git-common-dir`, so a Superset workspace belongs to its main repository), adds that repository to `privateDirs` or removes what covered the agent, and re-checks every agent at once. A hand edit of `config.json` is picked up the same way, without a restart.

Checked on the dev deployment: a flick caught at once moved 3 XP (all the flicker had) to the catcher, and the flicker saw who caught it; a flick tried 12 seconds later was "Too slow", the real scheduler had closed its window, and it counted toward the flicker's next superflick. `bun test` covers catching, the cap, the window, the streak and its reset, superflicks, a real git worktree resolving to its repository, and a real `serve` turning an agent private and open again. The HUD's snapshot mode drew a catchable flick, a superflick, the ⚡ buttons, the private switches and Settings' section order.

Not checked: a full superflick earned on a deployment (five flicks with their windows), the Catch! button on a macOS notification, and the switch from the installed app.

## The Operator chat and the icon (5 Oct 2026)

A chat message is a relay with `via: "chat"` (`operator.chat`). `route` sends it to one Claude call (`chatTurn`) with the crew's open agents, their routing summaries and the last six turns of the chat; the answer is JSON: the Operator replies itself (stored with `byOperator`, no agent asked, no XP), or names an agent and a question that stands alone (`routedQuestion`, which `readsFor` hands the daemon instead of the message). `operator.chatLog` is the chat, oldest first. The app opens it in a window of its own (`OperatorChat.swift`).

The icon is rendered by `apps/hud/icon/icon.py` in Blender 3.6 (Cycles, Metal): the mark's two eyes, a white ceramic ring and a violet neon ring that lights its iris, on a glossy black tile with a shadow catcher. `AppIcon.icns` is made from the 1024 px render with `sips` and `iconutil`, and `buildApp` copies it into the bundle.

Checked: `bun test` covers a chat answered by the Operator itself (no XP), one routed to an agent with its standalone question, the history a follow-up sees, and the JSON reading. On the dev deployment (routing stand-in), a chat message went through the real scheduler and came back answered by the Operator. The chat window and the HUD's chat button were drawn in snapshot mode.

Checked after the v0.6.0 release, with `operator:dryRun` and made-up agents on production: "who is around?" got the Operator's own short crew summary; "where does jimmy filter expired listings?" went to Jimmy's agent as a question that stands alone; the follow-up "and is that tested?" went to the same agent rewritten with the file it was about. The installed app's bundle carries `AppIcon.icns`.

Not checked: a chat from the installed app with a crewmate's real agent answering.

## Handles, crew_status, and answers from the summaries (5 Oct 2026)

Why: a Claude session asked the Operator what a crewmate was working on, and put his first name in as the handle. His handle was longer. A question with an @handle only looks at that exact handle's agents, so no agent was asked, the tool said "Work it out yourself", and the session went to search GitHub instead.

What changed:

- `route` matches each @mention to the crew first (`resolveMentions` in `lib/claude.ts`): the crewmate with that handle; else the one who linked that Superset handle; else the only crewmate whose handle, Superset handle, or a word of whose name starts with it ("@ada" finds @adalovelace). The agent is asked the question with the handle written out (`routedQuestion`), so the check on its answer passes. A mention that fits nobody, or more than one crewmate, ends the relay as `nobody` with the crew's handles in the note and `askAgain` set, and the MCP tool says to ask again with the right handle. In the chat, the Operator replies with the same note. A crewmate with no open agent, or the asker's own handle, gets a note of its own.
- The router answers in JSON: a reply from the routing summaries, an agent to ask, or nobody (`routeQuestion`). "What is @jimmy working on?" is answered from the summaries (`byOperator`), so no agent is asked and nobody earns XP for it.
- A second MCP tool, `crew_status` (`friends.crew`, with the daemon's token): each crewmate's handle, linked name and light.
- The skill names `crew_status`, says not to guess a handle, and says to look for the tools again while the MCP server is still starting.

Checked:

- `bun test`, typecheck and lint.
- The new router prompt against the real model (Opus 5.5, low effort), by running `routeQuestion` locally with made-up agents and the dev deployment's key. "What is @adalovelace working on?" and "what is jimmy working on?" got short answers from the summaries; "who is working on coupons?" named the agent on coupons; "Where does @jimmy filter expired listings, and why there?", "How does checkout pick a coupon?" and "Why do segment sends skip the mirror now?" went to the right agent; "What did Ana change…?" (nobody named Ana) got nobody. The long question from that session (branch, feature, files, and what is half done) got the branches, tasks and files from the summaries, and the answer said the summaries do not show what is half done.
- End to end on a local Convex backend (`CONVEX_AGENT_MODE=anonymous`, the routing stand-in), through the real MCP server over stdio, with a crewmate whose handle is longer than his first name: `crew_status` listed the crew; "What is @<first name> working on?" came back from the summaries; "@nobody" got the crew's handles and "Ask again"; a question about his code reached a stand-in for his daemon with the full handle written out, and the answer came back credited to his agent. The installed v0.7.0 MCP server against the new backend: its questions were matched and routed the same way (until it updates, it credits the Operator's own answers to "a crewmate's agent"), and it has no `crew_status`.
- A real Claude Code session (`claude -p`, Opus 5.5) with the new MCP server and the skill's text, asked to use soopdoop to ask that crewmate's agent, by first name, what it is working on: it called `crew_status`, asked about the full handle, and reported his work. A first run without the skill's text read the Operator's note as an invitation and asked his agent a second question; the note no longer invites one.

Not checked: production and the dev deployment (the local backend was used instead), and the HUD with these relays. The Operator's own answers can name a branch or folder from a routing summary even when its owner does not share workspace names; the chat has done the same since v0.6.0.

## Who-questions, and answers that sound like a teammate (5 Oct 2026)

Why: Mr. Tom asked his agent "who should I ask about contact enrichment?". It did not use soopdoop until he told it to. Then it turned the question into a long one (files, git history), and the Operator answered from the routing summaries: "All open agents belong to @…, and one is on enrichment … Its summary doesn't say what it changes or which files it touches." The agent passed all of that on, with the tool's note that no agent was asked. "All open agents" were one crewmate's only because the Operator does not count the asker's own agents, and the other crewmate's agents were private. What he wanted was one line naming the crewmate ("…'s got an agent working on enrichment right now. What would you like to know?"), and then his question going to that agent.

What changed:

- The router (`ROUTER` in `lib/claude.ts`) answers itself only when the summaries answer every part of a who-question or a "what is … working on" question. Anything that needs files, details, or whether something is still true goes to the agent. A who-question gets the person, their @handle once, and "What would you like to know?"; one that no agent fits gets one sentence saying nobody in the crew is on it. Replies never name agents, never describe the list of agents, and never talk about summaries or what the Operator can see. The chat prompt says the same.
- The `ask_operator` description says to use it as soon as a user asks who to ask, who knows, or what a crewmate is doing, and how to send the follow-up: the question with the @handle. The note under the Operator's own answers tells the agent how to pass it on and ask more, instead of saying that no agent was asked.
- The skill: who-questions trigger it, go out as they are in the user's words, and come back to the user in a sentence or two; the follow-up goes with the @handle. It says not to explain how the Operator found an answer.
- The agent that answers (`askPrompt` in `apps/daemon/src/ask.ts`) answers like a teammate in a chat: the answer first, "I" for its own work, no talk about its conversation, and part of an answer when it knows part.

Checked:

- `bun test` (a who-question in fake mode, its follow-up reaching the agent, a who-question that no agent fits), typecheck and lint.
- The router and chat prompts against the real model (Opus 5.5, low effort), run locally with made-up agents and the dev deployment's key, three times. "who should i ask about contact enrichment?" got "Ada (@adalovelace) has an agent on contact enrichment right now. What would you like to know?". The long question from that session went to the agent, and so did "@adalovelace: does enrichment skip contacts that already have an email?". "what is @adalovelace working on?" and "what's the crew working on?" got short answers that name no agents. "who knows about the billing webhooks?" got "Nobody in the crew is on the billing webhooks right now." In the chat, the who-question got the same invitation, and the follow-up went to the agent as a question that stands alone.
- The new answer prompt on a throwaway Claude Code session (its own config folder, made-up enrichment work): the answers started with the answer, in the first person, and a question it had not worked on came back as `NOT_FOUND`.
- A real Claude Code session (Opus 5.5, its own config folder, a stand-in soopdoop MCP server with the real tool list and replies) in a small repo. With the new skill, "who should i ask about contact enrichment?" called `ask_operator` at once with those words and told the user "Ask Ada. One of her agents is working on contact enrichment right now. … What do you want to know?". The follow-up went out as "@adalovelace: does contact enrichment skip CRM contacts that already have an email?", and the reply credited Ada's agent. With the released skill and tool text, the same question went to `crew_status` and then "What is @adalovelace working on right now?", and came back as a long list with notes on how the answer was found.

Not checked: production (the prompts ship with the next release). The Operator still does not see the asker's own agents.

## The app icon on Apple's template (5 Oct 2026)

Why: the icon was a 3D render of a tilted tile on a clear background. Its solid part was 823 × 835 px, lower than the middle, with a faint haze in the corners. macOS 26 drew it shrunk on a grey plate, because its shape was not Apple's. macOS 14 and 15 drew it as it was, a little smaller than other apps.

What changed: `apps/hud/icon/build.sh` makes the icon in three steps.

- `icon.py` renders the art in Blender 3.6 with Cycles on the GPU (Metal): the two eyes, face-on, on a dark surface that fills the square, at 2048 px. The settings: up to 2,048 samples, with adaptive sampling (threshold 0.002) and the OpenImageDenoise denoiser guided by the albedo and normal passes; path-traced global illumination with 16 bounces (8 diffuse, 8 glossy), caustics on and no fast-GI shortcut, and an indirect clamp of 10 against fireflies; a Blackman-Harris pixel filter; 16-bit output through Filmic. In the compositor, a denoised ambient occlusion pass darkens the creases by 35%, and a fog glow blooms around the neon. The render takes about 6 minutes on an M1 Max.
- `template.swift` fits the art to Apple's template at every size an `.icns` holds. The body is an 824 px square with continuous corners (radius 185.4), 100 px in from each edge of the 1024 px canvas. Around it the icon is see-through, with a soft shadow (10 px down, 16 px blur, 30% black), and a thin light rim inside the edge helps it read on a dark Dock. Each size is drawn straight from the 2048 px art.
- `iconutil` packs `AppIcon.icns`, and `icon-1024.png` is a copy of the 1024 px size to look at.

Checked:

- The body measures 824 × 824 px at 100 to 923, and the corners are fully see-through. The `.icns` holds all 10 sizes, from 16 to 1024 px, in sRGB.
- macOS 26.6 on this Mac, asked through `NSWorkspace` `icon(forFile:)` with a test bundle: the old icon came back shrunk on a grey plate, and the new one came back as it is, the same size as Terminal, Notes and Xcode.
- The 1024 px icon, cropped and looked at full size: no noise, smooth gradients, and sharp edges on the rings. The 64 px and 32 px sizes still show both eyes, on light and dark backgrounds.

Not checked: a Mac on macOS 14 or 15 (there is none here), and the icon in the Dock and in notifications, which waits for a release.

## Spike 1: our hooks beside Superset's (29 Sep 2026)

The installer adds one `soopdoop hook <event>` command per Claude Code event and leaves every other hook alone; reinstalling does not duplicate; uninstalling removes only ours. This is unit-tested (`apps/daemon/src/hooks.test.ts`), including the absolute-path form the installer now writes by default (`<bun> <cli.ts> hook <event>`), so the hook works without anything on PATH.

The daemon was run end to end against the dev deployment: hook payloads posted through the real `hook` subcommand, the subset showed up in `subsets.mine` within about a second, an agent under a `privateDirs` folder was reported with `open: false`, `Stop` made it idle, and `SessionEnd` removed it.

Verified on a real machine (1 Oct 2026): installed into Mr. Tom's `~/.claude/settings.json` (backup first, only hook entries added, Superset's untouched). Claude Code 2.1.287 picked the new hooks up in sessions that were already open, without a restart, and two live sessions appeared in Convex under `mbp16` within seconds.

The hook now runs `apps/daemon/src/hook.ts` instead of the full CLI: about 0.07 s per call instead of about 0.1 s, which matters because PreToolUse fires on every tool call in every session. It is wrapped as `[ -f hook.ts ] && bun hook.ts <event> || true`, so a deleted checkout or any failure exits 0 and prints nothing. It forwards only the event name, session id, cwd, transcript path and message; prompts and tool inputs never reach the socket.

## Spike 2: the rail as a Superset Page (29 Sep 2026)

Result: no. Superset's own Pages guide (the `page` skill installed with Superset) says pages run under `default-src 'none'`: `fetch`, XHR, EventSource and WebSockets are all blocked, and scripts must be inline. A live rail needs a WebSocket to Convex, so a Page cannot host it. A Page could show a static snapshot, which is useless for presence.

Consequence: the rail ships as its own window. Dev: `bun run rail` at `http://127.0.0.1:47312/`. Since 2 Oct 2026 that window is a native Mac app (see The Mac app, above), not a web page.

Not checked by publishing a page; taken from the policy text.

## Spike 3: host grants through the API

Not started. Phase 3.

## Tooling notes

- Bun 1.3 installs workspaces isolated (`node_modules/.bun/...`). `convex-test` cannot use `import.meta.glob` under `bun test`, so `packages/convex/convex/testing.helpers.ts` lists the modules by hand (two dots in the name: Convex skips multi-dot files, which is also why `*.test.ts` files are safe in `convex/`). Add a line there for every new file under `convex/`.
- Bun's fake timers (`jest.useFakeTimers` from `bun:test`) drive `convex-test`'s scheduler, which is how the knock expiry is tested without waiting 30 s.
- `npx convex run <fn> --identity '{"subject":"…","issuer":"…"}'` runs a session-authenticated function on the dev deployment as any hacker. Handy before a real sign-in exists.
- `.env.local` in `packages/convex` is per checkout and gitignored. A new checkout attaches to the same project with `npx convex dev --once --configure existing --team vibes --project soopdoop`.
