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
| This machine (paired automatically) | `subsets.pairDaemon`, then the local server's `/local/pair` |
| Superset profile on friends' rows, link and unlink your own | `superset.linkProfile`, `superset.unlinkProfile` |

## Run

Most people never run it by hand: `bin/soopdoop setup` runs `serve.ts` as a background service (`com.soopdoop.rail`) with `SOOPDOOP_SERVICE=1`, which serves a built page.

```sh
bun run rail            # http://127.0.0.1:47312/, hot reload (stop the service first: bin/soopdoop stop)
```

`serve.ts` serves the page through Bun's bundler, answers `/config.json` with the Convex URL (from `CONVEX_URL`, else `packages/convex/.env.local`, else the shared dev deployment in `src/config.ts`), forwards the sign-in token exchange (`/oauth/token`, below), and pairs this machine (`/local`, below). `bun run build` writes a static copy to `dist/`; it can show the rail but cannot finish a sign-in or pair a machine, because nothing answers `/oauth/token` or `/local` there.

Use `127.0.0.1`, not `localhost`: the Superset OAuth client is registered for `http://127.0.0.1:47312/` and the page redirects a localhost tab there.

## Sign in

`src/superset-auth.ts` runs OAuth 2.1 authorization code + PKCE against `api.superset.sh` as a public client (no secret). The ID token goes to Convex, which checks it against Superset's JWKS (`packages/convex/convex/auth.config.ts`). Tokens live in `localStorage`; the rail refreshes them with the refresh token.

Superset's token endpoint sends no CORS headers, so the page cannot call it. The page posts to its own server instead (`src/token-proxy.ts`), which forwards to Superset. The server fixes the client id and redirect, accepts only the two grants the rail uses, only from the rail's own origin, and logs nothing. Tokens go page → this machine → Superset and never touch our cloud.

If Convex refuses the token, the rail signs out and shows Convex's reason on the sign-in screen (`src/convex-logger.ts`).

## Pairing this machine

After sign-in the page asks its own server `GET /local` whether this machine is paired. If not, it asks Convex for a daemon token (`subsets.pairDaemon`, named after the machine, e.g. `mbp16`) and posts it to `POST /local/pair`. The server writes `~/.soopdoop/config.json` (mode 600) with its own Convex URL, and the daemon starts reporting within a second. `src/local.ts` takes the pairing only from the rail's own origin, answers `/local` only to the rail's own Host, and does not replace a working pairing unless asked.

## Invites

An invite link carries `?invite=<code>`. Sign-in leaves the page for Superset and comes back without the query string, so `src/invite.ts` keeps the code in `localStorage` until the invitee has a handle, then redeems it once. "Invite someone new" copies a message whose one line clones the code, runs `setup --invite <code>`, and so opens this page with the code.

## Superset profiles

Friends' rows show the name and tier from their linked public Superset profile, with achievements and models folded under "on Superset". The backend reads `https://superset.sh/md/user/<handle>` (see `packages/convex/convex/superset.ts`) and keeps no token counts, cost or rank.

## How it ships

Only as its own window for now. Superset Pages block WebSockets and fetch (see `docs/spikes.md`), so a Page cannot hold a live rail.

## Code

Vanilla TypeScript, no framework. `dom.ts` builds elements without HTML strings. `pkce.ts`, `format.ts`, `token-proxy.ts`, `convex-logger.ts` and the refresh rules in `superset-auth.ts` are tested (`bun test`). `rail.ts` owns the subscriptions and rendering; `main.ts` owns boot and screens.
