# drops

`soopdoop.com/d/<token>`: a small Cloudflare Worker in front of the backend's drop links. **It is not deployed yet.**

A drop is a page a crew shares (walkthroughs first), stored in Convex file storage by `packages/convex/convex/drops.ts` and served by the Convex deployment at `https://<deployment>.convex.site/d/<token>`. This Worker serves the same links at `soopdoop.com/d/<token>`: it sends the request on to the deployment and passes the answer back as it came.

## What it does

- Only `GET` and `HEAD` for `/d/` followed by 32 url-safe characters. Any other path is a 404 and any other method a 405; neither reaches the deployment.
- Only the method and the path go on. The visitor's query string, cookies and other headers stay behind.
- The deployment's status, headers and body come back unchanged: the content type, `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, and for pages the policy that allows inline styles and scripts but nothing on the network.
- Redirects come back to the browser, never followed here: a link-only drop sends the browser to its page, and a file bigger than 20 MB goes to its Convex storage URL.
- Nothing is cached at Cloudflare's edge (the deployment says `private`). A forgotten drop stops working at once, except in a browser that loaded it in the last five minutes.

`DROPS_ORIGIN` in `wrangler.jsonc` is the production deployment's site, `https://fleet-skunk-723.convex.site`.

## Try it on this Mac

```sh
bun test apps/drops                                                    # from the repo root: the handler against a stand-in origin
cd apps/drops && bunx wrangler@4 dev --local --var DROPS_ORIGIN:https://nautical-dalmatian-541.convex.site
curl -i http://localhost:8787/d/<token>                                # a drop saved on that deployment
```

`wrangler dev --local` runs the Worker in Cloudflare's runtime on this Mac and needs no sign-in.

## Deploy it later

1. Sign in to the Cloudflare account that serves soopdoop.com: `bunx wrangler@4 login`, then check it with `bunx wrangler@4 whoami`.
2. From this folder: `bunx wrangler@4 deploy` (or `bun run deploy`).

That adds the route `soopdoop.com/d/*` on the soopdoop.com zone. A route runs before the site's own Worker (`apps/site`, a custom domain on soopdoop.com) on the same hostname, so `/d/` paths come here and every other path still goes to the site. The site's custom domain already made the DNS record, so no DNS change is needed.

After it is deployed, the backend still gives out `https://fleet-skunk-723.convex.site/d/<token>` links, and they keep working. Giving out `soopdoop.com/d/<token>` links instead is a small backend change (`siteUrl` in `drops.ts` builds every drop link) that is not made yet.
