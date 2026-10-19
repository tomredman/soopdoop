# site

soopdoop.com: static pages, served by Cloudflare from the edge (a Worker with static assets only, no Worker code).

```sh
bun run dev       # http://127.0.0.1:47320/ with hot reload
bun run preview   # build, then serve dist/ exactly as Cloudflare will
bun run og        # render og/og.html → public/og.png and og/icon.html → public/apple-touch-icon.png (headless Chrome)
bun run deploy    # build and upload with wrangler (needs `bunx wrangler@4 login` once)
```

- `index.html` holds every word on the page, so it reads fine without JavaScript. `src/` adds the rest: the wordmark's eyes (`eyes.ts`), the hero demo (`stage.ts`), the canned Operator (`operator.ts`, answers in `game.ts`), knocks (`knock.ts`), visitor XP with the app's ranks (`xp.ts`), the background network (`wire.ts`) and the easter eggs (`eggs.ts`).
- `invite.html` (with `src/invite.ts`) is the page invite links open: `soopdoop.com/invite#<code>`. It fills in the install line with the code from the fragment, which never reaches the server, and links someone who already runs soopdoop to their local rail with the invite.
- `teams.html` (soopdoop for crews: the four numbers as a sample, what a crew gets, the plans, what leaves a Mac, the install line), `privacy.html` (exactly what leaves a Mac) and `terms.html` are served at `/teams`, `/privacy` and `/terms`. They use `src/pages.css` on top of `src/styles.css`, and `src/page.ts` (the nav, reveal on scroll and copy buttons, without the home page's XP or sound). The plan table follows `packages/convex/convex/lib/plan.ts`, and the privacy page follows what the backend and the daemon do: change them together. `privacy.html` and `terms.html` have placeholders (`[Company]`, `[contact email]`, `[governing law]`, shown in amber) for Mr. Tom to fill in before they go live.
- `public/` is copied as it is: the Recursive font (SIL Open Font License, `fonts/OFL.txt`), icons, the social card, the 404 page, and Cloudflare's `_headers` and `_redirects`. `/install` redirects to `install.sh` on GitHub, so `curl -fsSL https://soopdoop.com/install | bash` installs soopdoop.
- `wrangler.jsonc` attaches soopdoop.com and www.soopdoop.com as custom domains; Cloudflare makes their DNS records and certificates on deploy.
- The demo crew (@mira, @zed, @juno, @kit) and their taco app are made up, and so is the teams page's crew (@tom, @adalovelace, @jimmy, @grace). Use made-up names here, never real people.
- Nothing on the pages talks to a server: the Operator demo is canned and runs in the browser.
