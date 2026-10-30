/**
 * Ordered schema migrations. Index n takes the database from user_version n to
 * n+1. Append only: an entry that has run anywhere is history.
 *
 * Timestamps are ISO-8601 UTC strings. Calendar dates the user thinks in
 * (a task's due date, a follow-up date) are plain `YYYY-MM-DD` in the user's
 * own time zone, because "Monday" is a property of where Max is standing, not
 * of UTC.
 */
export const MIGRATIONS: string[] = [
  /* 1: everything */ `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',      -- owner | member
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  date_order    TEXT NOT NULL DEFAULT 'DMY',         -- DMY | MDY: how the user writes 05/08
  feed_token    TEXT NOT NULL UNIQUE,                -- read-only calendar feed secret
  settings      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                      -- sha256 of the cookie value
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,                        -- first chars, shown in the UI
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#64748b',
  guidance      TEXT NOT NULL DEFAULT '',            -- told to the model: what belongs here
  followup_days INTEGER NOT NULL DEFAULT 3,
  todoist_label TEXT NOT NULL DEFAULT '',
  tracks_people INTEGER NOT NULL DEFAULT 1,          -- do people in this category get chased?
  sort          INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, key)
);

CREATE TABLE captures (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL,                       -- device-generated; makes upload retries idempotent
  category_hint TEXT,                                -- the chip tapped, or NULL for Auto
  category      TEXT,                                -- what it was filed under
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued',      -- queued | processing | done | review | failed
  transcript    TEXT,
  extraction    TEXT,                                -- validated model output, JSON
  summary       TEXT,
  error         TEXT,
  captured_at   TEXT NOT NULL,                       -- when the phone took it
  created_at    TEXT NOT NULL,                       -- when the server received it
  processed_at  TEXT,
  UNIQUE (user_id, client_id)
);
CREATE INDEX captures_user_created ON captures (user_id, created_at DESC);

CREATE TABLE capture_files (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                         -- image | audio
  path        TEXT NOT NULL,                         -- relative to DATA_DIR/files
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX capture_files_capture ON capture_files (capture_id);

CREATE TABLE contacts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  role              TEXT,                            -- athlete | parent | coach | client | prospect | partner | other
  category          TEXT,
  stage             TEXT NOT NULL DEFAULT 'new',     -- new | contacted | replied | booked | client | parked | dead
  sport             TEXT,
  position          TEXT,
  level             TEXT,
  location          TEXT,
  organisation      TEXT,
  email             TEXT,
  phone             TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  next_followup_on  TEXT,                            -- YYYY-MM-DD, user's zone
  last_touch_at     TEXT,
  needs_review      INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX contacts_user ON contacts (user_id, archived, updated_at DESC);
CREATE INDEX contacts_followup ON contacts (user_id, next_followup_on);

CREATE TABLE contact_handles (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  platform    TEXT NOT NULL,                         -- instagram | tiktok | email | phone | whatsapp | ...
  handle      TEXT NOT NULL,                         -- normalised: lowercased, no @, digits-only for phones
  url         TEXT,
  UNIQUE (contact_id, platform, handle)
);
CREATE INDEX contact_handles_lookup ON contact_handles (user_id, platform, handle);

CREATE TABLE contact_events (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  capture_id  TEXT REFERENCES captures(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                         -- captured | stage | note | task_done | followup_raised | merged
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX contact_events_contact ON contact_events (contact_id, created_at DESC);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_id     TEXT REFERENCES captures(id) ON DELETE SET NULL,
  contact_id     TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'action',     -- action | followup
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  category       TEXT,
  channel        TEXT,
  link           TEXT,
  draft_message  TEXT,
  due_on         TEXT,                               -- YYYY-MM-DD
  due_time       TEXT,                               -- HH:MM or NULL
  due_source     TEXT NOT NULL DEFAULT 'default',    -- stated | default
  priority       INTEGER NOT NULL DEFAULT 2,         -- 1 (low) .. 4 (urgent), Todoist's own scale
  status         TEXT NOT NULL DEFAULT 'open',       -- open | done | dismissed
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX tasks_user_status ON tasks (user_id, status, due_on);
CREATE INDEX tasks_contact ON tasks (contact_id, status);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_id  TEXT REFERENCES captures(id) ON DELETE SET NULL,
  contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,                         -- YYYY-MM-DD
  start_time  TEXT,                                  -- HH:MM or NULL (all-day)
  end_time    TEXT,
  location    TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX events_user_date ON events (user_id, date);

CREATE TABLE review_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capture_id  TEXT REFERENCES captures(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                         -- possible_duplicate | low_confidence | date_dropped
  subject_id  TEXT,                                  -- the contact/task the item is about
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',          -- open | resolved
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX review_items_user ON review_items (user_id, status);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  dedupe_key   TEXT,                                 -- at most one queued/running job per key
  status       TEXT NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    TEXT NOT NULL,
  locked_at    TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX jobs_ready ON jobs (status, run_after);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TABLE integrations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  config_enc  TEXT NOT NULL DEFAULT '',              -- AES-256-GCM, see crypto.ts
  state       TEXT NOT NULL DEFAULT '{}',            -- non-secret bookkeeping (resolved project id, ...)
  last_ok_at  TEXT,
  last_error  TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE (user_id, kind)
);

CREATE TABLE deliveries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  integration  TEXT NOT NULL,
  object_type  TEXT NOT NULL,                        -- task | capture | contact
  object_id    TEXT NOT NULL,
  external_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'sent',         -- sent | closed
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (integration, object_type, object_id)
);
`,
];
