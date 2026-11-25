// Small helpers shared by the public and admin routes.

export const MAX_FILES = 50;
// The Images binding reads at most 20 MB per image.
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// JPEG, PNG and WebP only. iPhones convert HEIC to JPEG when the form's
// `accept` lists these types.
export const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
// An upload session must finish within this long of being started.
export const UPLOAD_WINDOW_MINUTES = 120;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export const clean = (v, max) => String(v ?? "").trim().slice(0, max);

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** "Field Day 2026!" -> "field-day-2026" */
export const slugify = (s, max = 60) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");

export const isSlug = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

export const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Constant-time comparison; hashing first makes both sides the same length.
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** Admin requests need `Authorization: Bearer <ADMIN_KEY>`. */
export async function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) throw new HttpError(503, "Admin access is not configured (ADMIN_KEY secret missing).");
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!(await safeEqual(given, env.ADMIN_KEY))) throw new HttpError(401, "Unauthorized");
}

export async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(503, "The bot check is not configured.");
  if (!token) throw new HttpError(400, "Please complete the bot check.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await res.json().catch(() => ({}));
  if (!out.success) throw new HttpError(400, "The bot check failed. Please reload the page and try again.");
}
