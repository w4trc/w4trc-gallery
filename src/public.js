// Public routes: the album API w4trc.org builds from, and the /submit flow.
//
// Submitting is three steps so large batches never hit request size limits:
//   POST /api/submissions                       start (form fields + Turnstile)
//   PUT  /api/submissions/:id/files?token&name  one request per photo
//   POST /api/submissions/:id/complete?token    finish and notify officers

import {
  ALLOWED_TYPES,
  HttpError,
  MAX_FILES,
  MAX_FILE_BYTES,
  UPLOAD_WINDOW_MINUTES,
  clean,
  isDate,
  json,
  randomToken,
  readJson,
  safeEqual,
  slugify,
  verifyTurnstile,
} from "./lib.js";

/** GET /api/gallery: every published album with its photos, newest first. */
export async function gallery(env) {
  const [{ results: albums }, { results: photos }] = await env.DB.batch([
    env.DB.prepare(
      `SELECT slug, title, date, description, cover_photo_id FROM albums
       WHERE published = 1 ORDER BY date DESC, slug`
    ),
    env.DB.prepare(
      `SELECT p.id, p.album_slug, p.file, p.width, p.height, p.alt, p.caption
       FROM photos p JOIN albums a ON a.slug = p.album_slug
       WHERE a.published = 1 ORDER BY p.album_slug, p.sort, p.id`
    ),
  ]);

  const byAlbum = Map.groupBy(photos, (p) => p.album_slug);
  const out = albums
    .filter((a) => byAlbum.has(a.slug))
    .map((a) => {
      const list = byAlbum.get(a.slug);
      const cover = list.find((p) => p.id === a.cover_photo_id) ?? list[0];
      return {
        slug: a.slug,
        title: a.title,
        date: a.date,
        description: a.description || undefined,
        cover: cover.file,
        photos: list.map(({ file, width, height, alt, caption }) => ({
          file,
          width,
          height,
          alt: alt || undefined,
          caption: caption || undefined,
        })),
      };
    });

  return json({ photosUrl: env.PHOTOS_URL, albums: out }, 200, { "Cache-Control": "public, max-age=60" });
}

export const config = (env) =>
  json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "", maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES });

/** POST /api/submissions */
export async function startSubmission(request, env) {
  const body = await readJson(request);
  const name = clean(body.name, 100);
  const callsign = clean(body.callsign, 12).toUpperCase();
  const email = clean(body.email, 200);
  const event = clean(body.event, 150);
  const eventDate = clean(body.event_date, 10);
  const notes = clean(body.notes, 2000);
  const expected = Number(body.file_count);

  if (!name) throw new HttpError(400, "Please enter your name.");
  if (callsign && !/^[A-Z0-9/]+$/.test(callsign)) throw new HttpError(400, "That callsign doesn't look right.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!event) throw new HttpError(400, "Please tell us which event the photos are from.");
  if (eventDate && !isDate(eventDate)) throw new HttpError(400, "Invalid event date.");
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_FILES)
    throw new HttpError(400, `Please choose between 1 and ${MAX_FILES} photos.`);
  if (body.consent !== true) throw new HttpError(400, "Please confirm you have permission to share these photos.");

  await verifyTurnstile(body.turnstile, request, env);

  const token = randomToken();
  const row = await env.DB.prepare(
    `INSERT INTO submissions (name, callsign, email, event, event_date, notes, expected_files, upload_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(name, callsign, email, event, eventDate, notes, expected, token)
    .first();

  return json({ id: row.id, token });
}

/** Loads a submission that is still accepting files and checks its token. */
async function openSubmission(env, id, token) {
  const sub = await env.DB.prepare(
    `SELECT *, (julianday('now') - julianday(created_at)) * 1440 AS age_minutes FROM submissions WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!sub || !token || !(await safeEqual(token, sub.upload_token))) throw new HttpError(403, "Invalid upload session");
  if (sub.status !== "uploading" || sub.age_minutes > UPLOAD_WINDOW_MINUTES)
    throw new HttpError(409, "This upload session has closed. Please start a new submission.");
  return sub;
}

const countUploads = async (env, id) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE submission_id = ?").bind(id).first()).n;

/** PUT /api/submissions/:id/files?token=T&name=photo.jpg (body: one image) */
export async function uploadFile(request, env, id) {
  const url = new URL(request.url);
  const sub = await openSubmission(env, id, url.searchParams.get("token"));

  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) throw new HttpError(415, "Only JPEG, PNG and WebP photos can be uploaded.");
  const size = Number(request.headers.get("Content-Length"));
  if (!size) throw new HttpError(411, "Missing file size");
  if (size > MAX_FILE_BYTES) throw new HttpError(413, "That photo is larger than 20 MB.");

  const n = await countUploads(env, id);
  if (n >= sub.expected_files) throw new HttpError(409, "All the photos for this submission are already uploaded.");

  const originalName = clean(url.searchParams.get("name") || "photo", 200);
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
  const key = `submissions/${id}/${String(n + 1).padStart(2, "0")}-${slugify(originalName.replace(/\.[^.]*$/, ""), 50) || "photo"}.${ext}`;

  // R2 checks the body against Content-Length, so a lying client fails here.
  const obj = await env.INBOX.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    "INSERT INTO uploads (submission_id, inbox_key, original_name, content_type, size) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, key, originalName, type, obj.size)
    .run();

  return json({ ok: true });
}

/** POST /api/submissions/:id/complete?token=T */
export async function completeSubmission(request, env, ctx, id) {
  const url = new URL(request.url);
  const sub = await openSubmission(env, id, url.searchParams.get("token"));
  const n = await countUploads(env, id);
  if (n === 0) throw new HttpError(400, "No photos were uploaded.");

  await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ?").bind(id).run();

  if (env.DISCORD_WEBHOOK_URL) {
    const embed = {
      title: `Gallery photos #${id}: ${n} photo${n === 1 ? "" : "s"} to review`,
      url: new URL("/admin", request.url).href,
      color: 0xf59e0b,
      fields: [
        { name: "From", value: sub.callsign ? `${sub.name} (${sub.callsign})` : sub.name, inline: true },
        { name: "Event", value: sub.event + (sub.event_date ? ` (${sub.event_date})` : ""), inline: true },
        ...(sub.notes ? [{ name: "Notes", value: sub.notes.slice(0, 1024) }] : []),
      ],
    };
    ctx.waitUntil(
      fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "W4TRC Gallery", embeds: [embed] }),
      })
    );
  }

  return json({ ok: true, count: n });
}
