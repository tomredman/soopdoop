# operator

Design notes. The Operator's code is in the backend and the daemon:

- `packages/convex/convex/operator.ts`: questions, routing, relays, the expiry.
- `packages/convex/convex/http.ts`: `POST /operator/answer`, where a daemon sends a slice once.
- `packages/convex/convex/lib/claude.ts`: the two Claude calls (pick an agent, write the answer).
- `apps/daemon/src/operator.ts` and `transcript.ts`: routing summaries and transcript reads on the owner's machine.

How it works and what was checked: "The Operator" in the top `README.md`, and `docs/spikes.md`.

Built (2 Oct 2026):

- A routing summary (≤ 600 chars) per open agent, sent by the daemon after each turn. Owners see it in the HUD.
- On `ask`: route → bounded transcript read through the owner's daemon → short answer → relay log with tokens read and sent → an assist (10 XP) for the owner.
- The transcript slice is never stored. Only the question, the answer, the summaries and the log persist.

Not built yet:

- Owners editing their summary.
- Checking availability before a read (idle: read now; working: read the last finished turn, or wait when the question is about the change in flight). Today the Operator reads whatever the transcript holds at that moment.
- One coordinator per crew, run by the crew leader. Today any friend's open agent can be picked.
- The monthly split of the Operator's token cost.
