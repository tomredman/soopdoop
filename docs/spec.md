# soopdoop

Status: product spec, not built. Nothing in this folder is shipped behaviour.

soopdoop is a multiplayer layer on top of [Superset](https://superset.sh), the desktop app that runs many coding agents in parallel. Your own Superset stays the main screen. The layer adds the people and agents around you: who is online, what they want to show you, and what their agents can help with.

Working name for the layer: **the Duper layer**. Short form: **the layer**.

Prototype of the layer UI: `prototype.html` (static HTML, example data only).

## Who it is for

**Hackers.** That is what the product calls every user. It means anyone who builds real software with agent harnesses. Many are new: they did not come from an engineering background, and more start every day. Software engineers are a large part of the users too, and they are hackers as well. The product must make sense without git or terminal knowledge, and must not make experienced engineers feel talked down to.

## Words the product uses

| Word | Meaning |
| --- | --- |
| hacker | Any user. |
| subset | One hacker's session and its agents. Empty subset: ∅. |
| crew | Up to 8 hackers (subsets) on the same project. |
| crew leader | The first hacker to invite others. Runs the Operator. |
| the Operator | The crew's coordinator agent (section 7). |
| jack in / jack out | Open or leave another hacker's session (section 5). |
| knock | A short "want to see this?" request (section 2). |
| eyes | A request for a second set of eyes (section 3). |
| assist | Your agent's context answered someone else's question. |
| ship | A pull request merged to the main branch. |
| props | A one-tap thank-you from a crewmate. |
| the wire | The quiet live feed of crew events in the rail. |
| DUPER, SUPERDUPERDUPERSET | Tree levels above crews (section 8). |
| Where companies are built | The company token tracker (section 10). |

## Tone rules

1. Quiet by default. No unread badges on every item. No sounds unless the user turns them on.
2. Nothing stays on screen if the user ignores it. Every interruption has a timer. Only one request (knock or eyes) shows at a time. Others wait in a small "pending" chip and show when the current one closes. Ship and badge toasts are not requests: they stack above requests, never cover them, and leave on their own after 6 seconds.
3. The user's own sessions always take most of the screen. The layer is a thin rail.
4. Playful, not loud. Celebrations are short LED bursts (under 1 second) and a toast that goes away after a few seconds. Only one at a time. Copy can use hacker slang where it is clear ("jack in", "∅ subset"), and must never need a glossary to act on.
5. Visual style: a modern harness (dark, dense, monospace data) with three LED colours that carry meaning:
   - green: online and working
   - blue: online, idle, open to knocks
   - purple: the Operator is relaying a question
   - no LED: offline or in focus mode

## Core features

### 1. Presence

- The rail shows friends and teammates with an LED and one line of state: the repo and the number of agents running (for example `vibes · 4 agents`).
- Presence shows only what the user allows. Default: online state and agent count. Repo names and session titles are opt-in.
- Focus mode hides the user from the rail and blocks all knocks until the user ends it or the timer runs out.

### 2. Knocks ("Tom wants you to see this")

A knock is a short, expiring request for attention with one item attached.

- Attachment types: file, link, a live session, an artifact, a diff, a screenshot.
- The receiver sees one small card with the sender, the item, and a countdown ring.
- Default lifetime: 30 seconds. The sender can pick 10 s, 30 s, or 2 min.
- If the receiver does nothing, the card goes away. The sender sees "not now" (not "ignored"). Nothing goes into an inbox. The sender can knock again later.
- If the receiver opens it, the item opens in a side pane. The sender sees "they're looking".
- Limits: at most one open knock from one sender to one receiver. A receiver can set a knock rate limit per person.

This copies the office behaviour: stop by the door; if the person is free, show them; if not, try later.

### 3. Second set of eyes ("Adam has requested a second set of eyes")

A bigger nudge than a knock. The sender wants you to look at their session live, now, with them. Example: "How can I change this prompt so it answers like yours did?"

- The sender writes one line that says what they want to show.
- The receiver sees a banner at the top of their main pane, not a small card. It shows the sender, the line, and the session.
- The request lasts 5 minutes. It then goes away and the sender sees "not now".
- Choices: **Join now**, **In 5 min** (the banner comes back once), **Not now**.
- Join opens the sender's session in Comment mode beside the receiver's own session. When the question compares two agents, the relevant turn from each side shows next to each other.
- Limits: one open request per sender. Not shown to anyone in focus mode.

### 4. Drops

A drop is a knock without a timer, for items the user wants to keep. Drops go to a shared shelf for a friend group or team. They are for artifacts, links, and session recordings that other people will want later.

### 5. Jack in (open another hacker's Superset)

A user can open a friend's session with one of three access levels. The owner sets the level per session.

| Level | What the visitor can do |
| --- | --- |
| Watch | See the live session output and file changes. Read only. This is the default. |
| Comment | Watch, plus put comments on lines of output or on diffs. The owner's agent does not read comments unless the owner forwards them. |
| Co-drive | Send prompts into the session. Each prompt is labelled with the visitor's name in the transcript. The owner can take control back at any time with one key. |

Rules for co-drive:
- The owner must approve each co-drive request for each session. Approval never carries over to a new session.
- Co-drive never gives the visitor access to the owner's secrets, env files, or connectors beyond what the session already uses.
- The owner sees a persistent purple border while anyone co-drives.

Classic engineers would reject co-drive. The target users will want it. The three levels let each owner choose.

### 6. Subsets and crews

A **subset** is one hacker's session and the agents running in it. A **crew** is up to 8 hackers working on the same project, so a crew is up to 8 subsets.

- Every member sees every other member's subset: agent name, current task, and state (working, idle).
- Any member can open any shared agent at the clock-in level its owner allows.
- A member with no agents running has an **empty subset**, shown as ∅. It is shown, but it cannot answer questions.
- Private agents are not part of a subset. They are never shown, summarized, or asked.
- A **crew** is the group of people who share sets. A crew has at most 8 people, including the leader.
- The first person to invite others is the **crew leader**. The crew leader owns the coordinator. The members share its cost.

### 7. The Operator (coordinator) and relayed asks

Agents never talk to each other directly. All questions go through one coordinator agent per crew. The crew leader owns it.

**What the coordinator keeps.** A short routing summary for each shared agent: what it is working on and which files and topics it has touched. Agents send an update at the end of each turn. Each agent's owner can see and edit that summary. The coordinator does not supervise, score, or report on anyone's work.

**What the coordinator does not keep.** The full context of other agents. It reads that context ephemerally: only to answer one question, and nothing it read is saved. The only thing that stays after a relay is the routing summary and the relay log.

How a relay works:
1. **Route.** The coordinator uses the routing summaries to pick the agent most likely to know.
2. **Check availability.**
   - Idle agent: the coordinator reads its context now.
   - Working agent: the coordinator reads its context as of its last finished turn, without interrupting it. If the question is about the change the agent is making right now, the coordinator waits for that turn to finish so it does not answer from a half-written change. The asker is told, for example: "Jimmy's Chad Agent would know, but it is working. I'll tell you when I have an answer."
   - Empty subset (∅): nothing can answer. The coordinator says so and offers to ask when that person starts an agent. It does not guess from the routing summary.
3. **Read and compress.** The coordinator reads the context, writes the smallest answer that covers the question, and returns it with two numbers: how much context it read and how big the answer is.
4. **Ephemeral.** The context it read is not saved anywhere. Only the question, the answer and the two numbers stay.

The answering agent is never asked to edit files or run commands for the asker. Because the coordinator reads the context itself, the answering agent spends no tokens.

**Who pays.** The members share the cost of the coordinator.
- Each month, the coordinator's token cost is split evenly among active members. An active member ran at least one agent or asked at least one question that month.
- A member who was not active that month pays nothing.
- Owners of answering agents pay nothing extra for being read. Their agents spend no tokens.
- The crew leader sets a monthly cap. When the cap is reached, the coordinator stops relaying and says so. It does not fall back to a cheaper answer without saying so.
- The crew leader can choose to pay the full cost instead of splitting it.
- Every member can see the month's total, their share, how many questions each member asked, and the estimated tokens saved.

Implicit incentive: a bigger crew means a smaller share for each person, and more agents to learn from. The product shows the share a new member would bring, for example "with 8 members your share is $6.08". It does not send invite reminders.

Why an even split and not "the asker pays": charging per question makes people ask less, and asking is the point. The asker already saves tokens in their own session on every answer.

Owner controls for each agent: let the coordinator read it automatically, ask me first, or never.

Every relay (question, route, answer) is logged. The asker and the answering agent's owner can both read it.

Why this matters:
- **Better answers.** The teammate's agent already has the working context. The asker's session would have to rebuild it.
- **Fewer tokens.** The asker receives a compressed answer instead of reading the codebase or docs to find the same thing.
- **Scales with people.** Each person added to a crew adds context that other members can reuse, so the savings grow with the size of the crew.
- **People learn from each other.** Members can see how teammates build: which agents they run, how they split work, and how their agents think. This goes both ways.

### 8. The tree: crews of crews

A company can have many crews. Crews are joined in a binary tree.

- **Leaves** are crews of up to 8 people. Each crew has its own coordinator, as in section 7.
- **Every node above the leaves** joins exactly two children and has its own coordinator. Level 1 joins two crews (the superduper**DUPER**set). Level 2 joins two level-1 nodes. And so on up to one root for the company.
- Size: 2 crews = 16 people, 4 = 32, 8 = 64. A company of 1,000 people is about 128 crews and 7 levels.

**What each level keeps.** Each coordinator keeps a short summary of each of its two children, never more. A crew coordinator summarizes agents. A level-1 coordinator summarizes two crews: the code areas they are in, decisions they made, what they are waiting on. Higher levels summarize systems and cross-cutting decisions. Each level has a fixed size limit per child, so a higher level holds a wider view with less detail. No coordinator holds anyone's full context. Full context is read only at the leaf, during a relay, and only ephemerally (same rule as section 7).

**How summaries move.** Agents update their crew coordinator at the end of each turn. Each coordinator updates its parent on a timer (for example every hour) and when something important changes, such as a schema change or a new decision.

**Relays across the tree.**
1. The crew coordinator cannot find the answer in its own crew.
2. It asks its parent. The parent checks its two child summaries. If neither matches, it asks its own parent.
3. The first coordinator whose summary matches routes the question down to the right crew, and that crew's coordinator reads the right agent's context.
4. The answering crew coordinator compresses the answer and sends it back to the asking crew coordinator. Every coordinator on the path logs the relay.

Only summaries are read on the way up and down. The full context of one agent is read once, at the end. The number of steps grows with the number of levels, not with the number of people: at most 7 up and 7 down for 1,000 people.

**Why a binary tree.** Each coordinator above the leaves compares only two things, so its job stays small and its summaries stay accurate. Which two crews are paired matters: pair crews that work on related code, so that their shared coordinator catches the most. The product suggests pairings from overlap in code areas; the crew leaders confirm. Pairings can change as work moves. With an odd number of crews, one node has a single child and passes its summary up unchanged.

**Team problems the tree helps with.** These existed before agents. They get worse now that each person runs many agents and produces the output of a small team.
- **Duplicate work.** Two crews build the same thing. Their shared coordinator sees overlapping summaries and tells both crew leaders.
- **Collisions.** Two crews change the same schema or module. The shared coordinator warns both before the changes meet at merge time.
- **"Who knows about X?"** The tree routes the question to the agent that worked on X, even in a crew the asker has never met.
- **Blocked on another team.** Crew A waits for an API that crew B is building. The shared coordinator can see both sides and tells A when B's summary says it is done.
- **Drifting conventions.** Two crews choose different libraries or patterns for the same job. Higher levels see it and flag it to both crews.
- **Change notices.** When a crew changes something that other crews depend on, the tree sends a notice only to crews whose summaries touch that area. It goes into their coordinator thread, not a knock.
- **Onboarding.** A new person asks questions and gets answers from the agents that did the work, not from old docs.
- **Status meetings.** The summary at each level is already the current state of the work in that part of the company.

**Rules that keep it from becoming surveillance.** The coordinator was never supervision, and the tree must not turn it into that.
- Summaries above the crew level describe work (code areas, decisions, dependencies), not people. They carry no per-person activity counts, token counts, or time data.
- Personal boards stay inside a crew.
- A crew can mark a topic as crew-only. It is not passed up.
- Private agents are never summarized at any level.
- Anyone can read the summary that any level holds about their own crew.

**Who pays for the upper levels.** The cost of each upper node is split evenly across the crews under it, then split inside each crew as in section 7. A company can choose to pay for all upper levels instead.

### 9. Play: ranks, badges, boards

The goal is to make helping each other the most rewarding thing to do in the product.

**Principles**
- Reward giving more than taking. Assists and eyes earn more XP than your own ships.
- Asking is good. Every question earns a small amount of XP.
- Only positive signals. No "lowest" lists, no inactivity callouts, no public shaming of any kind.
- Crew goals as well as personal ones (Full house, crew streaks, crew vs crew).
- A newcomer should get a win on day one. The first assist and the first ship each get a celebration.

**XP and ranks.** XP sources, highest first: assist given, eyes given (jacking in when asked), ship, props received, question asked. Ranks: n00b → script kiddie → hacker → wizard → legend. "n00b" is shown with pride, not as an insult.

**Hacker card.** Handle, crew, rank and XP bar, streak, and four numbers: assists, ships, eyes given, props. Plus badges.

**Badges** (starting set): First light (first ship of the day in the crew), Rubber duck (gave eyes 10 times), Oracle (10 assists in a week), Long distance (a question crossed the whole tree), Ghost (first co-drive), Full house (the crew fills all 8 seats, everyone in the crew gets it), Night shift (shipped after midnight), Hive mind (assisted 3 different crews).

**Moments.**
- Ship: when a crewmate ships, the crew sees a short toast with a "+ props" button.
- Assist: every relayed answer shows "+1 assist to @handle".
- The wire: a quiet live feed in the rail (ships, assists, badges, crews filling up). No sound, no counters.

**Boards.** Inside a crew, for today, this week, or all time:

| Board | What it counts |
| --- | --- |
| Assists | Times a hacker's agents answered someone else's question. |
| Eyes given | Times a hacker jacked in when asked for a second set of eyes. |
| Ships | Pull requests merged to the main branch. Lockfile-only and format-only changes do not count. |
| Props | Props received from the crew. |
| Crew vs crew | Assists a crew gave to other crews across the tree. |

Tokens are not a personal or crew board. Token counts are available as a small "receipt" under each answer and in crew settings, not as a score.

Rules:
- A hacker can hide from any board.
- Boards stay inside a crew. Only "Crew vs crew" is visible across the tree, and it counts crews, not people.

### 10. Where companies are built (company tracker)

A board of model token use across companies. Its title is "Where companies are built".

- **Top level: companies only.** One row per company: total model tokens for the week or month, change from the last period, and a bar split by model.
- **Expand a company** to see its tokens per model (for example Claude Opus, Sonnet, Fable, Haiku, and other providers), with each model's share.
- **Nothing below the company.** No crews, no people. This keeps the same rule as the tree: above the crew, work only, nothing about people.
- **Opt-in.** A company appears only when it chooses to. Inside a company, the tracker is the root of its own tree and is always visible to its members.
- **Source.** Token counts come from the model usage that each hacker's harness reports through the layer. How to check that these counts are real is an open question.

Tokens stay off the personal and crew boards (section 9). This tracker is the one place tokens are the score, and it counts companies.

### 11. Friends and invites

- A user with a Superset account adds another by handle or invite link.
- Friend requests need acceptance. A crew is a group with a leader and at most 8 people. At 8, the invite control is off and says the crew is full.
- An invite link lasts 7 days and can be used once.

### 12. Ping management

One settings panel with: focus mode, quiet hours, a per-person knock limit, and a per-agent ask policy. Everything the layer can do to interrupt a user can be turned off from that one panel.

## Architecture sketch

Not verified: whether Superset exposes a plugin API or an event stream that a third party can read. This must be checked first because it decides the whole integration approach. Options, in order of preference:

1. Contribute the layer to Superset upstream, if the project accepts it.
2. Build a companion app that runs next to Superset and reads the local session state that Superset writes.
3. Deliver relayed asks as an MCP server that each agent loads, with the coordinator as a hosted agent. This part works without any Superset integration and can ship first.

Backend: a realtime database with presence support. Convex fits this (presence, subscriptions, scheduled expiry of knocks). Session streaming for Watch and Co-drive needs a separate relay because output volume is high.

## Suggested build order

1. Friends, presence rail, and knocks with links and files.
2. Subsets, crews, and the coordinator, with relayed asks as an MCP server, the relay log, and owner controls.
3. The tree: level-1 nodes that join two crews, then higher levels.
4. Jack in: Watch, then Comment.
5. Play: XP, ranks, badges, boards, the wire.
6. Co-drive.

## Open questions

1. Does Superset expose anything a companion app can use (plugin API, local socket, session files)?
2. Where does this code live? It is not part of the VIBES product and should get its own repository before any implementation starts.
3. Is "the layer" the product name or only the internal name?
4. How are crews paired at the start, before there is any work history to measure overlap from?
5. How can the company tracker confirm that reported token counts are real?
