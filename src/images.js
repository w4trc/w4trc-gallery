// Turns a submitted original into the two gallery sizes with the Images
// binding. The binding applies EXIF orientation and drops EXIF/GPS metadata.

const SIZES = {
  t: { width: 640, quality: 72 }, // grid thumbnail
  d: { width: 2048, quality: 80 }, // lightbox / display copy
};

// Keys never change once written, so browsers and the CDN can keep them.
const PUBLIC_CACHE = "public, max-age=31536000, immutable";

export const photoKey = (album, size, file) => `albums/${album}/${size}/${file}.webp`;

async function resize(env, bytes, opts) {
  const result = await env.IMAGES.input(new Blob([bytes]).stream())
    .transform({ width: opts.width, fit: "scale-down" })
    .output({ format: "image/webp", quality: opts.quality });
  return result.response().arrayBuffer();
}

/** Makes both sizes of `bytes` and stores them. Returns the display size. */
export async function publishPhoto(env, bytes, album, file) {
  const out = {};
  for (const [size, opts] of Object.entries(SIZES)) {
    out[size] = await resize(env, bytes, opts);
    await env.PHOTOS.put(photoKey(album, size, file), out[size], {
      httpMetadata: { contentType: "image/webp", cacheControl: PUBLIC_CACHE },
    });
  }
  const info = await env.IMAGES.info(new Blob([out.d]).stream());
  return { width: info.width, height: info.height };
}

/** A small preview of a submitted original for the admin page. */
export async function previewResponse(env, bytes) {
  const result = await env.IMAGES.input(new Blob([bytes]).stream())
    .transform({ width: 480, fit: "scale-down" })
    .output({ format: "image/webp", quality: 70 });
  return result.response({ headers: { "Cache-Control": "private, max-age=3600" } });
}

/** Deletes the stored sizes of several photos in one call (R2 allows 1,000 keys). */
export async function deletePhotoFiles(env, album, files) {
  const keys = files.flatMap((file) => Object.keys(SIZES).map((size) => photoKey(album, size, file)));
  for (let i = 0; i < keys.length; i += 1000) await env.PHOTOS.delete(keys.slice(i, i + 1000));
}
