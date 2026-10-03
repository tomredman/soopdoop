# Changelog

## v0.2.3 · 2026-10-03

### Fixes
- you see what went wrong instead of "Server Error" (convex)

## v0.2.2 · 2026-10-03

### New
- soopdoop.com, with eyes, a live demo, a canned Operator and page XP (site)

### Fixes
- routing summaries never show your home folder (daemon)
- the HUD keeps its size and stays on screen (hud)
- let Cloudflare's analytics beacon through the content policy (site)

## v0.2.1 · 2026-10-03

### Fixes
- the HUD stays up while Settings is open (hud)
- small text reads on glass with a light window behind it (hud)

## v0.2.0 · 2026-10-02

### New
- add friends by handle, see your sent knocks and what the Operator knows (hud)
- the soopdoop Mac app: menu bar and a HUD over Superset (hud)
- the native app's backend: sign-in, live state, actions (rail)
- the Operator's machine side and the ask_operator tool (daemon)
- the Operator, routing summaries, XP and the crew board (convex)

### Fixes
- updates add the ask_operator tool when it is missing (cli)
- help text for the app; an invite waits for the app only if it was built (cli)

### Docs
- the Mac app, the HUD and the Operator
- MIT license

### Other
- build the Mac app before tagging (release)

## v0.1.1 · 2026-10-02

### Fixes
- setup and status check the pairing against the rail's deployment (cli)
- refuse hook posts from web pages (daemon)

## v0.1.0 · 2026-10-02

### New
- install.sh and the release script
- version, update notice, auto-update switch; installs use production (rail)
- releases and updates: check, install, roll back (daemon)
- pair this machine from the page, keep invites through sign-in (rail)
- soopdoop setup, background services, wait for pairing (daemon)
- link a hacker's public Superset leaderboard profile (convex)
- rail app, sign in with Superset, fast daemon hook (phase1)

### Fixes
- the empty friends list names the invite button (rail)
- commit the generated API so a fresh clone builds (convex)

### Docs
- install from the public repo; releases and updates
- how to try soopdoop with friends; what was checked

### Other
- a made-up example handle instead of a real person's
- lint Convex functions with the Convex ESLint rules (convex)
- scaffold soopdoop, Phase 1 backend and subset daemon
