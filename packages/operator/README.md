# operator

Design notes. The Operator's code is in the backend and the daemon:

- `packages/convex/convex/operator.ts`: questions, routing, relays, the expiry.
- `packages/convex/convex/http.ts`: `POST /operator/answer`, where a daemon sends its agent's answer once.
- `packages/convex/convex/lib/claude.ts`: the routing call (pick an agent), and the check on an agent's answer.
- `apps/daemon/src/operator.ts` and `ask.ts`: routing summaries, and asking an agent on the owner's machine.
- `packages/plugin/skills/soopdoop/SKILL.md`: the skill that tells agents when to ask. Setup installs it.

How it works and what was checked: "The Operator" in the top `README.md`, and `docs/spikes.md`.

Built (2 Oct 2026, asking the agent since 5 Oct 2026):

- A routing summary (≤ 600 chars) per open agent, sent by the daemon after each turn. Owners see it in the HUD.
- On `ask`: route → the owner's daemon asks the agent itself (a fork of its Claude Code session with no tools, saved nowhere) → the agent's short answer → relay log with tokens read and sent → an assist (10 XP) for the owner.
- No transcript leaves the machine. Only the question, the answer, the summaries and the log persist.
- For daemons from before 5 Oct 2026, the backend still takes a slice of the conversation and answers from it with Claude. Remove that path once every install has updated.

Not built yet:

- Owners editing their summary.
- Waiting for a working agent's turn to finish when the question is about the change in flight. Today the fork answers from wherever the agent is, which includes work in progress.
- One coordinator per crew, run by the crew leader. Today any friend's open agent can be picked.
- Who pays: the spec says owners of answering agents pay nothing. Asking the agent puts each answer on its owner's Claude account instead. The monthly split of the Operator's cost is not built either.
