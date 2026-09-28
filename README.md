# soopdoop

Your Superset, with your crew in it.

soopdoop is a multiplayer layer on top of [Superset](https://superset.sh). Your own Superset stays the main screen. soopdoop adds the people and agents around you: who is online, what they want to show you, and what their agents already know.

Status: Phase 1 in progress (see `docs/plan.html`). Nothing here is released.

## Layout

| Path | What it is |
| --- | --- |
| `docs/spec.md` | The product spec: hackers, subsets, crews, knocks, eyes, jack in, the Operator, the tree, play, the tracker. |
| `docs/plan.html` | The build plan and the reasons behind it (what Superset already provides, the licence, phases). |
| `packages/convex/` | The backend: hackers, friendships, subsets (presence), knocks with scheduled expiry. |
| `apps/daemon/` | The subset daemon. Runs on a hacker's machine, installs lifecycle hooks into the coding harnesses, reports presence, serves transcript reads to the Operator on request. |
| `apps/rail/` | The rail UI. `prototype.html` is the clickable design; the app wires it to Convex. |
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

## Develop

```sh
bun install
bun run convex     # Convex dev deployment (packages/convex)
bun run daemon     # the subset daemon, against the dev deployment
bun run rail       # the rail
```
