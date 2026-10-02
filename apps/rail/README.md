# rail

The soopdoop rail: a thin window beside Superset that shows your subset, your friends' LEDs, and knocks.

`prototype.html` is the approved clickable design (example data, every phase). The app in `index.html` + `src/` is the Phase 1 slice of it, wired to Convex:

| In the rail | Convex |
| --- | --- |
| Sign in with Superset, pick a handle | `hackers.me`, `hackers.claimHandle` |
| Your subset (machines, agents, private ◇) | `subsets.mine` |
| Friends with LEDs and agent counts | `friends.list` |
| Friend requests, add by handle, invite link | `friends.pending`, `friends.accept`, `friends.request`, `friends.createInvite`, `friends.redeemInvite` |
| Knock card with the countdown ring, pending chip | `knocks.incoming`, `knocks.decide` |
| "You knocked" outcomes | `knocks.sent` |
| Knock composer (link / page / file / session, 10 s · 30 s · 2 min) | `knocks.send` |
| Focus mode | `hackers.setFocus` |
| Sharing settings | `hackers.updateSharing` |
| Pair the daemon | `subsets.pairDaemon` |

## Run

```sh
bun run rail            # http://127.0.0.1:47312/
```

`serve.ts` serves the page through Bun's bundler with hot reload, answers `/config.json` with the Convex URL from `CONVEX_URL` or `packages/convex/.env.local`, and forwards the sign-in token exchange (`/oauth/token`, below). `bun run build` writes a static copy to `dist/`; it can show the rail but cannot finish a sign-in on its own, because nothing answers `/oauth/token` there.

Use `127.0.0.1`, not `localhost`: the Superset OAuth client is registered for `http://127.0.0.1:47312/` and the page redirects a localhost tab there.

## Sign in

`src/superset-auth.ts` runs OAuth 2.1 authorization code + PKCE against `api.superset.sh` as a public client (no secret). The ID token goes to Convex, which checks it against Superset's JWKS (`packages/convex/convex/auth.config.ts`). Tokens live in `localStorage`; the rail refreshes them with the refresh token.

Superset's token endpoint sends no CORS headers, so the page cannot call it. The page posts to its own server instead (`src/token-proxy.ts`), which forwards to Superset. The server fixes the client id and redirect, accepts only the two grants the rail uses, only from the rail's own origin, and logs nothing. Tokens go page → this machine → Superset and never touch our cloud.

If Convex refuses the token, the rail signs out and shows Convex's reason on the sign-in screen (`src/convex-logger.ts`).

## How it ships

Only as its own window for now. Superset Pages block WebSockets and fetch (see `docs/spikes.md`), so a Page cannot hold a live rail.

## Code

Vanilla TypeScript, no framework. `dom.ts` builds elements without HTML strings. `pkce.ts`, `format.ts`, `token-proxy.ts`, `convex-logger.ts` and the refresh rules in `superset-auth.ts` are tested (`bun test`). `rail.ts` owns the subscriptions and rendering; `main.ts` owns boot and screens.
