# w4trc-gallery

The backend for the club photo gallery at [w4trc.org/gallery](https://w4trc.org/gallery/). One Cloudflare Worker that:

- serves the public upload form at **`/submit`**
- serves the admin page at **`/admin`**: approve submissions into albums, edit albums, captions and alt text, choose covers, reorder and delete photos
- makes the gallery image sizes with the Images binding (640px thumbnail and 2048px display WebP, rotated upright, EXIF and GPS removed)
- serves **`/api/gallery`**, the album list that w4trc.org reads when it builds
- redirects old `gallery.w4trc.org/<album>/` (Hugo) links to `w4trc.org/gallery/<album>/`

## How a photo gets to the site

1. Someone sends photos at `/submit`. The originals go to the private R2 bucket `w4trc-photo-inbox`, and Discord gets a notice.
2. An officer opens `/admin`, ticks the photos to keep, picks or creates an album, and clicks **Add**. Each photo is resized into the public `w4trc-photos` bucket (served at `photos.w4trc.org`) and recorded in D1.
3. The admin page then calls `DEPLOY_HOOK_URL` to rebuild w4trc.org, which fetches `/api/gallery`. Without the hook, changes appear at the next daily rebuild. Edits to captions or albums go live the same way: click **Publish changes**.

## Storage

| What | Where |
|---|---|
| Albums, photos, submissions | D1 `w4trc-gallery` (`migrations/`) |
| Published images | R2 `w4trc-photos`: `albums/<album>/{t,d}/<file>.webp` |
| Submitted originals | R2 `w4trc-photo-inbox` (private): `submissions/<id>/...` |

## Setup (once)

```bash
npm install
npx wrangler d1 create w4trc-gallery          # put the id in wrangler.jsonc
npx wrangler r2 bucket create w4trc-photo-inbox
npm run db:migrate
npx wrangler d1 execute w4trc-gallery --remote --file=seed/migrated-albums.sql   # albums from the old Hugo site
npx wrangler secret put ADMIN_KEY             # admin page password
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put DISCORD_WEBHOOK_URL   # optional
npx wrangler secret put DEPLOY_HOOK_URL       # optional, rebuilds w4trc.org
npm run deploy
```

Set `TURNSTILE_SITE_KEY` in `wrangler.jsonc` from a Turnstile widget for the Worker's hostname, then add `gallery.w4trc.org` as the Worker's custom domain.

## Local development

```bash
npm run db:migrate:local
npx wrangler d1 execute w4trc-gallery --local --file=seed/migrated-albums.sql
npm run dev
```

Create `.dev.vars` (not committed) with Cloudflare's Turnstile test keys, which always pass:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
ADMIN_KEY=local-test-admin
```

To build w4trc.org against the local Worker: `GALLERY_API=http://localhost:8787 npm run build`.

## Limits

- 50 photos per submission, 20 MB each (the Images binding reads up to 20 MB), JPEG/PNG/WebP. iPhones convert HEIC to JPEG automatically.
- Upload sessions close 2 hours after they start.
- The admin page approves one photo per request so each stays well inside the Workers Free plan's 50-subrequest limit.
- Images: the Free plan includes 5,000 unique transformations a month. Each approved photo uses 2, plus 1 for its admin preview.
