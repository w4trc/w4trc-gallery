// Admin routes under /api/admin/. Every one needs the ADMIN_KEY bearer token
// (checked in index.js before these run).

import { deletePhotoFiles, previewResponse, publishPhoto } from "./images.js";
import { HttpError, clean, isDate, isSlug, json, readJson, slugify } from "./lib.js";

// ---- Submissions ----------------------------------------------------------

/** GET /api/admin/submissions[?all=1]: pending (or all) submissions with their uploads */
export async function listSubmissions(request, env) {
  const all = new URL(request.url).searchParams.get("all") === "1";
  const { results: subs } = await env.DB.prepare(
    `SELECT id, name, callsign, email, event, event_date, notes, expected_files, status, created_at
     FROM submissions
     WHERE ${all ? "status != 'uploading' OR created_at < datetime('now', '-1 day')" : "status = 'pending'"}
     ORDER BY created_at DESC, id DESC LIMIT 200`
  ).all();
  if (!subs.length) return json([]);

  const { results: uploads } = await env.DB.prepare(
    `SELECT id, submission_id, original_name, size, status FROM uploads
     WHERE submission_id IN (${subs.map(() => "?").join(",")}) ORDER BY id`
  )
    .bind(...subs.map((s) => s.id))
    .all();
  const bySub = Map.groupBy(uploads, (u) => u.submission_id);
  return json(subs.map((s) => ({ ...s, uploads: bySub.get(s.id) ?? [] })));
}

async function getUpload(env, id) {
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first();
  if (!upload) throw new HttpError(404, "Photo not found");
  return upload;
}

async function readOriginal(env, upload) {
  const obj = await env.INBOX.get(upload.inbox_key);
  if (!obj) throw new HttpError(404, "The original file is missing.");
  return obj.arrayBuffer();
}

/** GET /api/admin/uploads/:id/preview */
export async function previewUpload(env, id) {
  return previewResponse(env, await readOriginal(env, await getUpload(env, id)));
}

/** Marks a submission done once none of its uploads are pending. */
async function settleSubmission(env, submissionId) {
  await env.DB.prepare(
    `UPDATE submissions SET status = CASE
       WHEN EXISTS (SELECT 1 FROM uploads WHERE submission_id = ?1 AND status = 'pending') THEN 'pending'
       ELSE 'done' END
     WHERE id = ?1 AND status IN ('pending', 'done')`
  )
    .bind(submissionId)
    .run();
}

/**
 * POST /api/admin/uploads/:id/approve  { album }
 * Makes the gallery sizes, adds the photo to the album, and marks the upload
 * approved. The admin page calls this once per photo.
 */
export async function approveUpload(request, env, id) {
  const { album } = await readJson(request);
  const upload = await getUpload(env, id);
  if (upload.status === "approved") throw new HttpError(409, "This photo is already in the gallery.");
  const exists = await env.DB.prepare("SELECT 1 FROM albums WHERE slug = ?").bind(album ?? "").first();
  if (!exists) throw new HttpError(400, "Choose an album first.");

  // Unique within the album because the upload id is in it.
  const file = `${slugify(upload.original_name.replace(/\.[^.]*$/, ""), 40) || "photo"}-${upload.id}`;
  const { width, height } = await publishPhoto(env, await readOriginal(env, upload), album, file);

  const photo = await env.DB.prepare(
    `INSERT INTO photos (album_slug, file, width, height, sort, upload_id)
     VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(sort), 0) + 1 FROM photos WHERE album_slug = ?1), ?5)
     RETURNING id, file, width, height`
  )
    .bind(album, file, width, height, upload.id)
    .first();
  await env.DB.prepare("UPDATE uploads SET status = 'approved' WHERE id = ?").bind(id).run();
  await settleSubmission(env, upload.submission_id);
  return json(photo);
}

/** PATCH /api/admin/uploads/:id  { status: "rejected" | "pending" } */
export async function updateUpload(request, env, id) {
  const { status } = await readJson(request);
  if (!["rejected", "pending"].includes(status)) throw new HttpError(400, "Invalid status");
  const upload = await getUpload(env, id);
  if (upload.status === "approved") throw new HttpError(409, "Delete the photo from its album instead.");
  await env.DB.prepare("UPDATE uploads SET status = ? WHERE id = ?").bind(status, id).run();
  if (status === "pending")
    await env.DB.prepare("UPDATE submissions SET status = 'pending' WHERE id = ? AND status = 'done'")
      .bind(upload.submission_id)
      .run();
  else await settleSubmission(env, upload.submission_id);
  return json({ ok: true });
}

/** DELETE /api/admin/submissions/:id: removes the originals. Approved photos stay in their albums. */
export async function deleteSubmission(env, id) {
  const { results } = await env.DB.prepare("SELECT inbox_key FROM uploads WHERE submission_id = ?").bind(id).all();
  if (results.length) await env.INBOX.delete(results.map((r) => r.inbox_key));
  await env.DB.batch([
    env.DB.prepare("UPDATE photos SET upload_id = NULL WHERE upload_id IN (SELECT id FROM uploads WHERE submission_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM uploads WHERE submission_id = ?").bind(id),
    env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// ---- Albums and photos ----------------------------------------------------

/** GET /api/admin/albums: every album, published or not, with its photos */
export async function listAlbums(env) {
  const [{ results: albums }, { results: photos }] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM albums ORDER BY date DESC, slug"),
    env.DB.prepare("SELECT id, album_slug, file, width, height, alt, caption, sort FROM photos ORDER BY sort, id"),
  ]);
  const byAlbum = Map.groupBy(photos, (p) => p.album_slug);
  return json({ photosUrl: env.PHOTOS_URL, albums: albums.map((a) => ({ ...a, photos: byAlbum.get(a.slug) ?? [] })) });
}

function albumFields(body, { partial }) {
  const out = {};
  if (!partial || "title" in body) {
    out.title = clean(body.title, 150);
    if (!out.title) throw new HttpError(400, "The album needs a title.");
  }
  if (!partial || "date" in body) {
    out.date = clean(body.date, 10);
    if (!isDate(out.date)) throw new HttpError(400, "The album needs a date (YYYY-MM-DD).");
  }
  if ("description" in body) out.description = clean(body.description, 2000);
  if ("published" in body) out.published = body.published ? 1 : 0;
  if ("cover_photo_id" in body) out.cover_photo_id = body.cover_photo_id == null ? null : Number(body.cover_photo_id);
  return out;
}

/** POST /api/admin/albums  { title, date, description?, slug? } */
export async function createAlbum(request, env) {
  const body = await readJson(request);
  const fields = albumFields(body, { partial: false });
  const slug = body.slug ? clean(body.slug, 60) : slugify(fields.title);
  if (!isSlug(slug)) throw new HttpError(400, "The web address can only use lowercase letters, numbers and hyphens.");
  if (await env.DB.prepare("SELECT 1 FROM albums WHERE slug = ?").bind(slug).first())
    throw new HttpError(409, `There is already an album at /gallery/${slug}/.`);

  await env.DB.prepare("INSERT INTO albums (slug, title, date, description) VALUES (?, ?, ?, ?)")
    .bind(slug, fields.title, fields.date, fields.description ?? "")
    .run();
  return json({ slug });
}

/** PATCH /api/admin/albums/:slug  { title?, date?, description?, published?, cover_photo_id? } */
export async function updateAlbum(request, env, slug) {
  const fields = albumFields(await readJson(request), { partial: true });
  const cols = Object.keys(fields);
  if (!cols.length) return json({ ok: true });
  const { meta } = await env.DB.prepare(`UPDATE albums SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE slug = ?`)
    .bind(...Object.values(fields), slug)
    .run();
  if (!meta.changes) throw new HttpError(404, "Album not found");
  return json({ ok: true });
}

/** DELETE /api/admin/albums/:slug: deletes the album and all its photos */
export async function deleteAlbum(env, slug) {
  const { results } = await env.DB.prepare("SELECT file FROM photos WHERE album_slug = ?").bind(slug).all();
  await deletePhotoFiles(env, slug, results.map((r) => r.file));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM photos WHERE album_slug = ?").bind(slug),
    env.DB.prepare("DELETE FROM albums WHERE slug = ?").bind(slug),
  ]);
  return json({ ok: true });
}

/** PATCH /api/admin/photos/:id  { alt?, caption?, sort? } */
export async function updatePhoto(request, env, id) {
  const body = await readJson(request);
  const fields = {};
  if ("alt" in body) fields.alt = clean(body.alt, 300);
  if ("caption" in body) fields.caption = clean(body.caption, 500);
  if ("sort" in body) fields.sort = Math.trunc(Number(body.sort)) || 0;
  const cols = Object.keys(fields);
  if (!cols.length) return json({ ok: true });
  const { meta } = await env.DB.prepare(`UPDATE photos SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();
  if (!meta.changes) throw new HttpError(404, "Photo not found");
  return json({ ok: true });
}

/** DELETE /api/admin/photos/:id */
export async function deletePhoto(env, id) {
  const photo = await env.DB.prepare("SELECT album_slug, file FROM photos WHERE id = ?").bind(id).first();
  if (!photo) throw new HttpError(404, "Photo not found");
  await deletePhotoFiles(env, photo.album_slug, [photo.file]);
  await env.DB.batch([
    env.DB.prepare("UPDATE albums SET cover_photo_id = NULL WHERE cover_photo_id = ?").bind(id),
    env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

/** POST /api/admin/rebuild: asks w4trc.org to rebuild so changes go live */
export async function rebuildSite(env) {
  if (!env.DEPLOY_HOOK_URL)
    return json({ ok: false, message: "No rebuild hook is set up, so changes appear with the next daily rebuild." });
  const res = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
  if (!res.ok) throw new HttpError(502, `The rebuild hook returned HTTP ${res.status}.`);
  return json({ ok: true, message: "Rebuild started. Changes will be live on w4trc.org in a few minutes." });
}
