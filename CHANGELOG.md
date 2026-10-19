# Changelog

## v0.14.1 · 2026-10-19

### New
- a crew can be put on a plan by hand, for a comped crew or for trying the team plan before billing exists (crews)
- Checkout follows the Checkout Studio page settings, and automatic tax waits for the head office (billing)
- Checkout collects tax, a billing address and a tax ID through Stripe Tax (billing)

### Docs
- the seat count followed a member leaving and coming back, against real Stripe (billing)
- a test Checkout was paid for real, and the webhook, the plan and the portal followed (billing)
- the head office address comes first, or Stripe refuses every Checkout (billing)

## v0.14.0 · 2026-10-19

### New
- Drops: your crew's shelf of walkthroughs, pages and links in the HUD, with a one-line box to share a link (hud)
- the HUD's crew rows are the crew when you are in one, and the Settings note names hand-offs and heads-ups (convex)
- the menu bar shows your crew: a light per crewmate (green working, blue idle, grey off, a ring in focus, a purple pulse while one answers you), a count of hand-offs waiting, a glance menu with what each is on and yesterday's digest, and Hand off… and Shout… composers under the menu bar (hud)
- Settings → Crew to start or run your crew (members, the digest's hour, Slack, Intercom, who may hand work to your agents, notes from agents, the Operator's cost, Team billing) and Settings → This Mac (Haiku ledger lines, the scout, the hand-off allowance) (hud)
- turning the scout on from Settings also starts its hourly job on a Mac set up by soopdoop (rail)
- hand-offs and heads-ups as cards you answer, ships, shouts and props on the wire, yesterday's digest, crew notes, your ledger, and the crew's four numbers (hud)
- the crew's shelf in the app's state, drops and billing actions, and a walkthrough that becomes a drop on the team plan (rail)
- POST /walkthrough writes a page about a finished piece of work (daemon)
- hand-offs run in the crewmate's agent and report back, with hand_off and report_back for agents (daemon)
- the daemon knows each session's permission mode (daemon)
- your sessions hear about the crew's work and notes, and your finished work goes to the ledger (daemon)
- the scout: props from customers, read from Intercom every hour by Haiku on your own Claude plan (daemon)
- agents can propose a crew note (crew_note), list the crew's notes (crew_notes) and send props (props) (daemon)
- crew notes for every session: told at its start, a line when one changes, and crew.md for Codex and Grok (daemon)
- a hand-off tells its Mac whether "run when idle" accepted it, and starting one can carry a delivery note (convex)
- heads-ups scored on your Mac: a prompt about a crewmate's work names their agent before you build (daemon)
- ledger lines made on your Mac: one line per finished piece of work, in Haiku's words on your own Claude account (daemon)
- crew leaders pay for the team plan with Stripe, monthly or yearly, and the seat count follows the crew (billing)
- soopdoop.com/teams for crews, and privacy and terms pages that say exactly what leaves your Mac (site)
- uploadFile puts a file from this Mac on the crew's shelf (upload link, bytes, save), ready for the walkthrough action (rail)
- a Cloudflare Worker that serves drop links at soopdoop.com/d/<token>, written and tried with wrangler dev, not deployed yet (drops)
- drops: a crew's pages and files at an unguessable /d/ link (team plan, 5 GB a crew), links on any plan, walkthroughs on the ledger and the wire (convex)
- the app reads your crew, its numbers and costs, your ledger, crew notes, hand-offs, consents, heads-ups, the digest and the wire's new kinds (hud)
- the app follows your crew (members, settings, the four numbers, costs), your ledger, crew notes, hand-offs, heads-ups and the digest, and can act on each (rail)
- the app's state shows This Mac's ledger line, scout and hand-off allowance settings (rail)
- settings for the ledger's Haiku line, the scout and the hand-off allowance (on, off and $10 a day until changed) (daemon)
- the Operator answers from the crew's ledger, offers work orders as hand-offs instead of refusing them, and chats with tools, on Sonnet 5.5 (operator)
- the ledger, heads-ups and hand-offs: what each crewmate finished, a card before you repeat their work, and tasks you hand to a crewmate's agent (convex)
- crewmates' questions reach Codex and Grok agents through a fork of their session, priced by the fund (daemon)
- Codex and Grok sessions show up: hooks beside Superset's, replays by other tools dropped, and soopdoop's tools in both (daemon)
- read Codex rollouts and Grok sessions into the same shape as Claude Code transcripts, with first prompts, PR links and merges (daemon)
- props from customers through Intercom's rating webhook, credited to whoever's ledger line names the conversation (convex)
- the room: shouts and props on the wire, customer props and saves from the scout, and a daily digest and weekly numbers posted to the crew's Slack (convex)
- crew notes: live shared instructions that reach every crewmate's agent, with age nudges and agent proposals the owner approves (convex)
- crews: a name, a leader, up to 8 members and settings; an invite link starts or joins one, and in a crew your crewmates are the crew (convex)
- tables for crews, the ledger, crew notes, hand-offs, heads-ups, digests and drops, and new kinds on the wire (convex)

### Fixes
- a ledger line that ends with a quoted title keeps its closing quote (daemon)
- a heads-up made with a crewmate's old agent key makes no card instead of a card about no agent (convex)
- a hand-off the agent could not do is reported as not done, not as done (daemon)
- a crewmate's hand-off arriving in your session no longer sets off a heads-up about that crewmate (daemon)
- the scout skips its runs on the free plan, the wire's heads-up line names the area, and the add-friend, ledger-cost, boundary and site words match the code
- /teams says exactly which of the three things that leave your Mac you see or can change (site)
- the home page fits a 320 px phone, and its FAQ gives the plans and all three tools (site)
- `soopdoop scout` no longer falls through into the hand-off allowance command, and the type check now refuses such fall-throughs (daemon)
- a hand-off that finishes before its delivery command returns still gets reported back (daemon)
- an idle Claude Code session no longer turns "waiting" a minute after its turn (daemon)
- the seat count catches up after Checkout, old reads cannot bring back an ended plan, and a crew that paid twice falls back (billing)
- a ledger line's log entry is written before the line counts as done, and the scout's plist is checked (daemon)
- crew.md writes that start together each use their own temporary file, and heads-up areas leave out src (daemon)
- the fund prices Claude Haiku 5.5 sessions at Haiku's rates, not the dearest model's (daemon)
- the Operator acts only on what you said, consent changes take back what "run when idle" accepted, and private sessions keep their ledger lines (convex)
- a forgotten ledger line stays forgotten, hand-offs carry the asker's own words, and private agents never hand off or run one (convex)

### Docs
- what the crews checks left on this Mac was cleaned up
- crews end to end on one Mac: what ran on the dev deployment, what broke where the parts meet, and what was not checked (docs)
- the README says what setup now writes on a Mac, and its Crews section says what the code does
- hand-offs into a running session, checked on a real Mac and on the dev deployment
- agents offer hand-offs to crewmates and report back on the ones they were given (skill)
- the ledger, heads-ups and crew notes on the Mac: what ran against the dev deployment, and what did not
- what agents do with a heads-up, with crew notes, and with props from customers (skill)
- a forgotten drop can stay in a browser that loaded it in the last five minutes (drops)
- crews in the README, and the ledger line as the second thing allowed to leave a Mac (docs)
- what to set up in Stripe and on production before Upgrade works (billing)
- every agent on the wire: Codex and Grok in setup, and what was and was not checked on a real Mac
- the crews plan: how soopdoop becomes something a team pays for (docs/plan-crews.html)

### Other
- the serve test runs its daemon on a free port (daemon)
- one `--snapshot <dir>` run draws the HUD, the menu bar icon, the composers and Settings (hud)
- the hand-offs' backend adapter in serve() on readable lines (daemon)
- the hand-off and walkthrough tests say what they cover at the top (daemon)
- the billing portal action is called the way the app calls it (rail)
- a copy of a session can be asked any prompt, with a longer wait and a longer reply (daemon)
- the settings a fresh Mac starts with include the new ledger, scout and hand-off defaults (rail)
- generated API types and the test harness for the crews modules (convex)

## v0.13.1 · 2026-10-07

### Fixes
- Settings → Account shows a box to type your Superset handle in, so Link is no longer stuck grey (hud)

### Docs
- v0.13.0 installed on a real Mac: a session's introduction to the crew, and the tokens saved

### Other
- made-up people in tests, comments and docs instead of a real crewmate's name

## v0.13.0 · 2026-10-07

### New
- the wire: a quiet feed of your crew's last day (agents answering each other, new agents, flicks), and how many tokens soopdoop saved you and your crew (hud)
- a new Claude Code session is introduced to what your crewmates' running agents are working on, and hears about agents that start later (operator)

### Docs
- the wire and tokens saved, and what was checked
- introductions to the crew's agents, and what was checked
- v0.12.0 installed on a real Mac, with the watcher running and auto-open switched through the live agent

## v0.12.0 · 2026-10-07

### New
- soopdoop opens when Superset opens, even after you quit it (on by default; turn it off in Settings or with soopdoop auto-open off) (hud)

### Docs
- soopdoop opens with Superset (the watcher), and what was checked

## v0.11.0 · 2026-10-05

### New
- a network-switch light next to the soopdoop name flickers while the Operator works or an agent answers (hud)
- crewmates' questions are answered on Claude Sonnet 5.5, half what a first question costs on Opus (daemon)
- a question that asks a crewmate's agent to do work is turned away before any agent is read (operator)
- the anti-hijacking fund: your agents spend at most $5 a day answering crewmates, half of it per crewmate (soopdoop fund) (daemon)

### Fixes
- a who-question that also asks for details (files, whether it is still right) goes to the agent, instead of an answer pieced together from the summaries (operator)

### Docs
- what an answer costs, corrected (an hour-long cache write at twice the input price), and answers on Sonnet 5.5
- the anti-hijacking fund, work orders, and what an answer really costs

## v0.10.0 · 2026-10-05

### New
- a crewmate's agent answers like a teammate in a chat: the answer first, in the first person (daemon)
- agents ask the Operator as soon as you ask who to ask about something, send your follow-up to that crewmate's agent, and pass answers on in a sentence (skill)
- "who should I ask about X?" gets a teammate's answer and "What would you like to know?"; questions that need details go straight to the agent (operator)

### Fixes
- the app icon follows Apple's template, so macOS 26 shows it as it is instead of shrinking it onto a grey plate (hud)

### Docs
- who-questions, answers that sound like a teammate, and what was checked

## v0.9.0 · 2026-10-05

### New
- just @handles unless you turn real names on in Settings; fold This Mac to one line; open the Operator to see its last 3 moves (hud)

### Fixes
- the Operator reads ephemerally; "forgotten" sounded like what it read went unused (site)

### Docs
- reads are "ephemeral", not "forgotten", in the spec, the build plan and the rail prototype

## v0.8.0 · 2026-10-05

### New
- "@ada" finds @adalovelace, crew_status lists the crew, and "what is @jimmy working on?" comes from the summaries (operator)

### Docs
- asking by first name, crew_status, answers from the summaries, and what was checked

## v0.7.0 · 2026-10-05

### New
- every flick you send is 1 XP and every knock 2, whatever happens to them (play)

## v0.6.1 · 2026-10-05

### New
- the HUD's message line is soopdoop green, and getting flicked comes with a line ("you gonna just take that?") (hud)

### Docs
- the Operator chat checked against the real model

## v0.6.0 · 2026-10-05

### New
- a new app icon, two eyes in white ceramic and violet neon, rendered in Blender (hud)
- chat with the Operator: it answers crew questions itself, or asks the agent that knows (operator)

### Docs
- the Operator chat, the icon, what was checked

## v0.5.0 · 2026-10-05

### New
- put the HUD's sections in any order in Settings; This Mac starts off (hud)
- a private switch for each agent under This Mac keeps its whole project private (privacy)
- catch a flick in its first 10 seconds and take the flicker's XP; 5 clean flicks in a row earn a SUPERFLICK (flicks)

### Fixes
- links on the invite page are the size of the text around them (site)

### Docs
- catching flicks, superflicks, the private switch, section order, what was checked

## v0.4.0 · 2026-10-05

### New
- flick a friend, a pointless poke; each flick back adds one to the rally (flicks)
- add a friend by soopdoop or Superset handle; anyone not on soopdoop gets an invite link to send (friends)

### Fixes
- the knock composer's Cancel and Knock buttons no longer wrap (hud)

### Docs
- invites by handle, the invite page, flicks, what was checked

## v0.3.0 · 2026-10-05

### New
- the Operator is one line, how many questions were answered today; no Ask box (hud)
- setup installs the soopdoop skill, so agents know when to ask the Operator (cli)
- the Operator asks the crewmate's agent itself instead of reading its conversation (operator)

### Docs
- the Operator asks agents, the skill, the one-line HUD section, what was checked

## v0.2.5 · 2026-10-03

### New
- operator:forget deletes a wrong answer from the wire (convex)

## v0.2.4 · 2026-10-03

### Fixes
- the Operator only answers about whose agent it read (convex)

## v0.2.3 · 2026-10-03

### Fixes
- you see what went wrong instead of "Server Error" (convex)

## v0.2.2 · 2026-10-03

### New
- soopdoop.com, with eyes, a live demo, a canned Operator and page XP (site)

### Fixes
- routing summaries never show your home folder (daemon)
- the HUD keeps its size and stays on screen (hud)
- let Cloudflare's analytics beacon through the content policy (site)

## v0.2.1 · 2026-10-03

### Fixes
- the HUD stays up while Settings is open (hud)
- small text reads on glass with a light window behind it (hud)

## v0.2.0 · 2026-10-02

### New
- add friends by handle, see your sent knocks and what the Operator knows (hud)
- the soopdoop Mac app: menu bar and a HUD over Superset (hud)
- the native app's backend: sign-in, live state, actions (rail)
- the Operator's machine side and the ask_operator tool (daemon)
- the Operator, routing summaries, XP and the crew board (convex)

### Fixes
- updates add the ask_operator tool when it is missing (cli)
- help text for the app; an invite waits for the app only if it was built (cli)

### Docs
- the Mac app, the HUD and the Operator
- MIT license

### Other
- build the Mac app before tagging (release)

## v0.1.1 · 2026-10-02

### Fixes
- setup and status check the pairing against the rail's deployment (cli)
- refuse hook posts from web pages (daemon)

## v0.1.0 · 2026-10-02

### New
- install.sh and the release script
- version, update notice, auto-update switch; installs use production (rail)
- releases and updates: check, install, roll back (daemon)
- pair this machine from the page, keep invites through sign-in (rail)
- soopdoop setup, background services, wait for pairing (daemon)
- link a hacker's public Superset leaderboard profile (convex)
- rail app, sign in with Superset, fast daemon hook (phase1)

### Fixes
- the empty friends list names the invite button (rail)
- commit the generated API so a fresh clone builds (convex)

### Docs
- install from the public repo; releases and updates
- how to try soopdoop with friends; what was checked

### Other
- a made-up example handle instead of a real person's
- lint Convex functions with the Convex ESLint rules (convex)
- scaffold soopdoop, Phase 1 backend and subset daemon
