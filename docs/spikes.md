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

## Spike 1: our hooks beside Superset's (29 Sep 2026)

The installer adds one `soopdoop hook <event>` command per Claude Code event and leaves every other hook alone; reinstalling does not duplicate; uninstalling removes only ours. This is unit-tested (`apps/daemon/src/hooks.test.ts`), including the absolute-path form the installer now writes by default (`<bun> <cli.ts> hook <event>`), so the hook works without anything on PATH.

The daemon was run end to end against the dev deployment: hook payloads posted through the real `hook` subcommand, the subset showed up in `subsets.mine` within about a second, an agent under a `privateDirs` folder was reported with `open: false`, `Stop` made it idle, and `SessionEnd` removed it.

Verified on a real machine (1 Oct 2026): installed into Mr. Tom's `~/.claude/settings.json` (backup first, only hook entries added, Superset's untouched). Claude Code 2.1.287 picked the new hooks up in sessions that were already open, without a restart, and two live sessions appeared in Convex under `mbp16` within seconds.

The hook now runs `apps/daemon/src/hook.ts` instead of the full CLI: about 0.07 s per call instead of about 0.1 s, which matters because PreToolUse fires on every tool call in every session. It is wrapped as `[ -f hook.ts ] && bun hook.ts <event> || true`, so a deleted checkout or any failure exits 0 and prints nothing. It forwards only the event name, session id, cwd, transcript path and message; prompts and tool inputs never reach the socket.

## Spike 2: the rail as a Superset Page (29 Sep 2026)

Result: no. Superset's own Pages guide (the `page` skill installed with Superset) says pages run under `default-src 'none'`: `fetch`, XHR, EventSource and WebSockets are all blocked, and scripts must be inline. A live rail needs a WebSocket to Convex, so a Page cannot host it. A Page could show a static snapshot, which is useless for presence.

Consequence: the rail ships as its own window. Dev: `bun run rail` at `http://127.0.0.1:47312/`. Later: a slim always-on-top window (Electron or Tauri) around the same page.

Not checked by publishing a page; taken from the policy text.

## Spike 3: host grants through the API

Not started. Phase 3.

## Tooling notes

- Bun 1.3 installs workspaces isolated (`node_modules/.bun/...`). `convex-test` cannot use `import.meta.glob` under `bun test`, so `packages/convex/convex/testing.helpers.ts` lists the modules by hand (two dots in the name: Convex skips multi-dot files, which is also why `*.test.ts` files are safe in `convex/`). Add a line there for every new file under `convex/`.
- Bun's fake timers (`jest.useFakeTimers` from `bun:test`) drive `convex-test`'s scheduler, which is how the knock expiry is tested without waiting 30 s.
- `npx convex run <fn> --identity '{"subject":"…","issuer":"…"}'` runs a session-authenticated function on the dev deployment as any hacker. Handy before a real sign-in exists.
- `.env.local` in `packages/convex` is per checkout and gitignored. A new checkout attaches to the same project with `npx convex dev --once --configure existing --team vibes --project soopdoop`.
