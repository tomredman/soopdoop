# rail

Two things run from here, both served by `serve.ts` on `127.0.0.1:47312`:

- **The agent** for the soopdoop Mac app (`apps/hud`): it signs in with Superset, follows Convex, and does what the app asks. The app shows what the agent sends and holds nothing itself. See "The agent", below.
- **The web rail**: the same crew in a browser page. It is what you get on a Mac without Xcode's command line tools, and on Linux or Windows.

`prototype.html` is the approved clickable design (example data, every phase). The web rail in `index.html` + `src/` is the Phase 1 slice of it, wired to Convex:

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

`serve.ts` serves the page through Bun's bundler, answers `/config.json` with the Convex URL (from `CONVEX_URL`, else `packages/convex/.env.local` for a development checkout, else the production deployment in `src/config.ts`), forwards the sign-in token exchange (`/oauth/token`, below), and answers `/local` (pairing, version and updates, below). `bun run build` writes a static copy to `dist/`; it can show the rail but cannot finish a sign-in or pair a machine, because nothing answers `/oauth/token` or `/local` there.

Use `127.0.0.1`, not `localhost`: the Superset OAuth client is registered for `http://127.0.0.1:47312/` and the page redirects a localhost tab there.

## Sign in

`src/superset-auth.ts` runs OAuth 2.1 authorization code + PKCE against `api.superset.sh` as a public client (no secret). The ID token goes to Convex, which checks it against Superset's JWKS (`packages/convex/convex/auth.config.ts`). Tokens live in `localStorage`; the rail refreshes them with the refresh token.

Superset's token endpoint sends no CORS headers, so the page cannot call it. The page posts to its own server instead (`src/token-proxy.ts`), which forwards to Superset. The server fixes the client id and redirect, accepts only the two grants the rail uses, only from the rail's own origin, and logs nothing. Tokens go page → this machine → Superset and never touch our cloud.

If Convex refuses the token, the rail signs out and shows Convex's reason on the sign-in screen (`src/convex-logger.ts`).

## Pairing this machine

After sign-in the page asks its own server `GET /local` whether this machine is paired with the deployment this rail uses. If not, it asks Convex for a daemon token (`subsets.pairDaemon`, named after the machine, e.g. `mbp16`) and posts it to `POST /local/pair`. The server writes `~/.soopdoop/config.json` (mode 600) with its own Convex URL, and the daemon starts reporting within a second. `src/local.ts` takes the pairing only from the rail's own origin, answers `/local` only to the rail's own Host, and does not replace a working pairing with the same deployment unless asked. A pairing with another deployment (a machine that moved from dev to production) is replaced.

## Version and updates

`GET /local` also says which version runs, the newest release the updater has seen, whether auto-update is on, and whether an update is running or failed (`src/updates.ts` shows it). The version sits at the bottom right and links to its release notes. When a newer release is out, a note says so; "Update now" posts to `POST /local/update`, which asks the background updater (`com.soopdoop.updater`) to install it now. The updater restarts the rail, and the page reloads when the version changes. ⚙ → This machine has the auto-update switch (`POST /local/settings`).

## Invites

An invite link carries `?invite=<code>`. Sign-in leaves the page for Superset and comes back without the query string, so `src/invite.ts` keeps the code in `localStorage` until the invitee has a handle, then redeems it once. "Invite someone new" copies a message whose one line runs the installer with `--invite <code>`, which installs the newest release and opens this page with the code.

## Superset profiles

Friends' rows show the name and tier from their linked public Superset profile, with achievements and models folded under "on Superset". The backend reads `https://superset.sh/md/user/<handle>` (see `packages/convex/convex/superset.ts`) and keeps no token counts, cost or rank.

## The agent

`src/agent.ts`, for the Mac app. It keeps the app's state and sends all of it to every connected app on each change, over a WebSocket at `/app`.

- **Sign-in:** `src/session.ts` runs OAuth 2.1 with PKCE in this process, with a loopback redirect on `http://127.0.0.1:47313/` (Superset ignores the port of a loopback redirect, so the client registered for 47312 works; see `docs/spikes.md`). The tokens live in `~/.soopdoop/session.json` (mode 600) and are refreshed before they run out.
- **Live data:** `hackers.me`, `play.board`, `friends.list`, `friends.pending`, `knocks.incoming`, `knocks.sent`, `subsets.mine`, `routing.mine` and `operator.log`, and `/local`'s answer about this machine.
- **Actions** (`{id, action, args}` in, `{type: "result", id, ok, value | error}` out): `signIn`, `signOut`, `claimHandle`, `knock`, `decideKnock`, `setFocus`, `updateSharing`, `addFriend`, `acceptFriend`, `invite`, `linkSuperset`, `unlinkSuperset`, `ask`, `setHideFromBoards`, `setAutoUpdate`, `updateNow`, `openRail`.
- **After sign-in** it pairs this machine the same way the web rail does, and redeems an invite that `soopdoop setup --invite` left in `~/.soopdoop/invite`.
- **Who may connect:** `/app` needs `Authorization: Bearer <token>` with the token from `~/.soopdoop/app-token` (mode 600, made by `src/app-api.ts`), and refuses any request that has a browser `Origin`, so no web page can use it.
- **The contract:** the app decodes `AppState` leniently. Add fields; never rename or remove one, and keep every action name working, because an installed app can be older than its agent.

`src/app-backend.test.ts` tests the sign-in, the socket's checks and the actions.

## How it ships

As the Mac app and its agent, with the web rail as the fallback. Superset Pages block WebSockets and fetch (see `docs/spikes.md`), so a Page cannot hold a live rail.

## Code

Vanilla TypeScript, no framework. `dom.ts` builds elements without HTML strings. `pkce.ts`, `format.ts`, `token-proxy.ts`, `convex-logger.ts` and the refresh rules in `superset-auth.ts` are tested (`bun test`). `rail.ts` owns the subscriptions and rendering; `main.ts` owns boot and screens.
