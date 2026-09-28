# operator

Phase 2. One coordinator per crew.

- Keeps a routing summary (≤ 600 chars) per open agent, updated from the daemon's turn-stop deltas. Owners can see and edit it.
- On `ask`: route → check availability (idle: read now; working: read the last finished turn, or wait when the question is about the change in flight; ∅: say so) → bounded transcript read via the asker's crewmate's daemon → one-line answer → relay log with tokens read / tokens sent → "+1 assist".
- Forgets the transcript slice after the answer. Nothing but the summary and the log persists.
