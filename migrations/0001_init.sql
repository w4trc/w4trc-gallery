-- Albums shown at w4trc.org/gallery/<slug>/
CREATE TABLE albums (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  description TEXT NOT NULL DEFAULT '',
  cover_photo_id INTEGER,           -- NULL = first photo
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Published photos. The files are albums/<album_slug>/{t,d}/<file>.webp in
-- the PHOTOS bucket; width/height are the display (d) size.
CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_slug TEXT NOT NULL REFERENCES albums(slug),
  file TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  upload_id INTEGER,                -- the submitted original, if any
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (album_slug, file)
);
CREATE INDEX photos_album ON photos (album_slug, sort, id);

-- Photo submissions from /submit.
-- status: uploading -> pending -> done (every upload approved or rejected)
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  callsign TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  event TEXT NOT NULL,
  event_date TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  expected_files INTEGER NOT NULL,
  upload_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One submitted original in the INBOX bucket.
-- status: pending -> approved | rejected
CREATE TABLE uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  inbox_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX uploads_submission ON uploads (submission_id);
