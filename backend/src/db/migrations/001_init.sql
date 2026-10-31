CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,            -- sha1(site + ':' + external_id)
  site              TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  company           TEXT NOT NULL DEFAULT '',
  company_norm      TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL,
  title_norm        TEXT NOT NULL,
  location          TEXT NOT NULL DEFAULT '',
  description_text  TEXT NOT NULL DEFAULT '',
  requirements_text TEXT NOT NULL DEFAULT '',
  url               TEXT NOT NULL,
  posted_at         TEXT,
  apply_type        TEXT NOT NULL CHECK (apply_type IN ('site_one_click','site_questionnaire','external','email')),
  apply_target      TEXT NOT NULL DEFAULT '',
  language          TEXT NOT NULL DEFAULT 'he',
  details_fetched   INTEGER NOT NULL DEFAULT 0,
  raw_json          TEXT NOT NULL DEFAULT '{}',
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'discovered'
                    CHECK (status IN ('discovered','scored','queued','needs_review','ready','submitted','failed','blocked','skipped')),
  status_reason     TEXT,
  prefilter_pass    INTEGER,                     -- NULL = not evaluated yet
  prefilter_reason  TEXT,
  duplicate_of      TEXT REFERENCES jobs(id),
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (site, external_id)
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_dedupe ON jobs(company_norm, title_norm, first_seen_at);

CREATE TABLE scores (
  job_id               TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content_hash         TEXT NOT NULL,
  model                TEXT NOT NULL,
  score                INTEGER NOT NULL,
  matched_skills       TEXT NOT NULL DEFAULT '[]',
  missing_requirements TEXT NOT NULL DEFAULT '[]',
  seniority_fit        TEXT NOT NULL,
  reasoning_he         TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE llm_cache (
  key        TEXT PRIMARY KEY,                   -- sha1(model + schema + messages)
  model      TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- discover | score | full | apply
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed','blocked','stopped')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats_json  TEXT NOT NULL DEFAULT '{}',
  reason      TEXT
);

-- Phase 2 tables (created now so the schema is stable)
CREATE TABLE answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  norm_key    TEXT NOT NULL UNIQUE,
  answer      TEXT,                               -- NULL while pending
  type        TEXT NOT NULL DEFAULT 'text',       -- text | yes_no | number | select | textarea
  language    TEXT NOT NULL DEFAULT 'he',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active','pending')),
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  company_norm      TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  dry_run           INTEGER NOT NULL DEFAULT 1,
  plan_json         TEXT NOT NULL DEFAULT '[]',   -- fields with value + provenance {source, ref, confidence}
  gate_json         TEXT,
  screenshot_before TEXT,
  screenshot_after  TEXT,
  confirmation_text TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  submitted_at      TEXT
);
CREATE INDEX idx_app_company ON applications(company_norm, submitted_at);
