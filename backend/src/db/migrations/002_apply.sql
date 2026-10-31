-- Phase 2: add 'dry_run_ok' to job statuses (SQLite needs a table rebuild to change a CHECK constraint),
-- answer options/source, and application review fields.
CREATE TABLE jobs_new (
  id                TEXT PRIMARY KEY,
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
                    CHECK (status IN ('discovered','scored','queued','needs_review','ready','dry_run_ok','submitted','failed','blocked','skipped')),
  status_reason     TEXT,
  prefilter_pass    INTEGER,
  prefilter_reason  TEXT,
  duplicate_of      TEXT REFERENCES jobs(id),
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (site, external_id)
);
INSERT INTO jobs_new SELECT * FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_dedupe ON jobs(company_norm, title_norm, first_seen_at);

ALTER TABLE answers ADD COLUMN options TEXT;                     -- JSON array for choice questions
ALTER TABLE answers ADD COLUMN source TEXT NOT NULL DEFAULT 'user'; -- seed | user | review
ALTER TABLE answers ADD COLUMN last_used_at TEXT;

ALTER TABLE applications ADD COLUMN site TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN reviewed_at TEXT;
CREATE INDEX idx_app_job ON applications(job_id);
CREATE INDEX idx_app_status ON applications(status);
