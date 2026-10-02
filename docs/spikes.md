# Spikes and findings

What was checked while building Phase 1, and what was not. Dates are when the check was made.

## Sign in with Superset (29 Sep 2026)

Superset is a full OpenID Connect provider. `https://api.superset.sh/.well-known/openid-configuration` lists the authorize and token endpoints, a JWKS (`/api/auth/jwks`, RS256), PKCE S256, refresh tokens with `offline_access`, public clients (`token_endpoint_auth_method: none`), and RFC 7591 dynamic client registration. `https://superset.sh/auth.md` documents the flow for agents.

Done: registered a public client named `soopdoop` with redirect `http://127.0.0.1:47312/` (Superset rewrote `localhost` to `127.0.0.1`). The client id is in `apps/rail/src/config.ts` and in the deployment env var `SUPERSET_CLIENT_ID`; `packages/convex/convex/auth.config.ts` trusts ID tokens from `https://api.superset.sh` whose `aud` is that client.

First real sign-in (1 Oct 2026): the authorize step works. Mr. Tom signed in at Superset and was sent back to the rail with a code. The code exchange then failed in the browser with "Failed to fetch": Superset's token endpoint answers without any `Access-Control-Allow-Origin` header (checked with a POST carrying `Origin: http://127.0.0.1:47312`, and an OPTIONS preflight, both without CORS headers), so a page on another origin can never read its reply. The userinfo endpoint does send CORS headers; the token endpoint does not.

Fix: the rail's own server forwards the exchange (`apps/rail/src/token-proxy.ts`, route `POST /oauth/token`). Checked against the real endpoint: a made-up code sent from the page comes back as Superset's own `invalid_grant · invalid code`, and a made-up refresh token as `invalid_grant · session not found`. Consequence for shipping: the desktop shell must make this call from its own process; a static page cannot sign in.

Verified (1 Oct 2026, after the fix): Mr. Tom signed in end to end. Superset's token response carried an ID token, Convex accepted it with `auth.config.ts` as written, and `claimHandle` created hacker `tom` whose `supersetUserId` is Superset's user id (a UUID). The rail then paired machine `mbp16`.

Open question: Superset's docs say a registration "is anonymous until the user claims it via browser consent". If only one user can claim a client, every rail install must register its own client, and Convex must stop pinning `aud` (custom JWT without `applicationID`). Check with a second hacker before inviting anyone.

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
