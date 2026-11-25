// W4TRC gallery Worker.
//
//   /submit                 public photo upload form (public/submit.html)
//   /admin                  admin page (public/admin.html)
//   /api/gallery            published albums, read by w4trc.org at build time
//   /api/submissions/...    the upload form's API (see public.js)
//   /api/admin/...          admin API (see admin.js), needs ADMIN_KEY
//
// Anything else is an old gallery.w4trc.org (Hugo) address and redirects to
// the matching page on w4trc.org.

import * as admin from "./admin.js";
import { HttpError, json, requireAdmin } from "./lib.js";
import * as pub from "./public.js";

const ID = "(\\d+)";
const SLUG = "([a-z0-9-]+)";

// [method, path pattern, handler(request, env, ctx, ...captures), admin?]
const routes = [
  ["GET", "/api/gallery", (req, env) => pub.gallery(env)],
  ["GET", "/api/config", (req, env) => pub.config(env)],
  ["POST", "/api/submissions", (req, env) => pub.startSubmission(req, env)],
  ["PUT", `/api/submissions/${ID}/files`, (req, env, ctx, id) => pub.uploadFile(req, env, +id)],
  ["POST", `/api/submissions/${ID}/complete`, (req, env, ctx, id) => pub.completeSubmission(req, env, ctx, +id)],

  ["GET", "/api/admin/submissions", (req, env) => admin.listSubmissions(req, env), true],
  ["DELETE", `/api/admin/submissions/${ID}`, (req, env, ctx, id) => admin.deleteSubmission(env, +id), true],
  ["GET", `/api/admin/uploads/${ID}/preview`, (req, env, ctx, id) => admin.previewUpload(env, +id), true],
  ["POST", `/api/admin/uploads/${ID}/approve`, (req, env, ctx, id) => admin.approveUpload(req, env, +id), true],
  ["PATCH", `/api/admin/uploads/${ID}`, (req, env, ctx, id) => admin.updateUpload(req, env, +id), true],
  ["GET", "/api/admin/albums", (req, env) => admin.listAlbums(env), true],
  ["POST", "/api/admin/albums", (req, env) => admin.createAlbum(req, env), true],
  ["PATCH", `/api/admin/albums/${SLUG}`, (req, env, ctx, slug) => admin.updateAlbum(req, env, slug), true],
  ["DELETE", `/api/admin/albums/${SLUG}`, (req, env, ctx, slug) => admin.deleteAlbum(env, slug), true],
  ["PATCH", `/api/admin/photos/${ID}`, (req, env, ctx, id) => admin.updatePhoto(req, env, +id), true],
  ["DELETE", `/api/admin/photos/${ID}`, (req, env, ctx, id) => admin.deletePhoto(env, +id), true],
  ["POST", "/api/admin/rebuild", (req, env) => admin.rebuildSite(env), true],
].map(([method, pattern, handler, isAdmin]) => [method, new RegExp(`^${pattern}$`), handler, isAdmin]);

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path.startsWith("/api/")) {
    let pathMatched = false;
    for (const [method, re, handler, isAdmin] of routes) {
      const m = path.match(re);
      if (!m) continue;
      pathMatched = true;
      if (method !== request.method) continue;
      if (isAdmin) await requireAdmin(request, env);
      return handler(request, env, ctx, ...m.slice(1));
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed" : "Not found");
  }

  // Old Hugo gallery addresses.
  if (path === "/upload") return Response.redirect(new URL("/submit", url), 301);
  const gallery = `${env.SITE_URL}/gallery/`;
  const segment = path.split("/")[1];
  if (segment && /^[a-z0-9-]+$/.test(segment)) {
    const album = await env.DB.prepare("SELECT slug FROM albums WHERE slug = ? AND published = 1").bind(segment).first();
    if (album) return Response.redirect(`${gallery}${album.slug}/`, 301);
  }
  return Response.redirect(gallery, 301);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};
