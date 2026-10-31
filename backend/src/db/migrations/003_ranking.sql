-- Role types, required experience, ranking inputs. Also drops the status CHECK constraint so new statuses
-- (skipped_experience, skipped_screening, …) don't need another table rebuild; statuses are validated in code.
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
  status            TEXT NOT NULL DEFAULT 'discovered',
  status_reason     TEXT,
  prefilter_pass    INTEGER,
  prefilter_reason  TEXT,
  duplicate_of      TEXT REFERENCES jobs(id),
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  role_types        TEXT NOT NULL DEFAULT '[]',   -- role type ids whose queries found this job
  required_years    REAL,                         -- highest minimum years required (null = unknown)
  required_years_source TEXT,                     -- regex | llm
  required_years_text   TEXT,                     -- matched text (provenance)
  junior_text       TEXT,                         -- matched junior / entry-level signal, if any
  UNIQUE (site, external_id)
);
INSERT INTO jobs_new (id, site, external_id, company, company_norm, title, title_norm, location, description_text, requirements_text,
  url, posted_at, apply_type, apply_target, language, details_fetched, raw_json, content_hash, status, status_reason, prefilter_pass,
  prefilter_reason, duplicate_of, first_seen_at, last_seen_at, updated_at)
SELECT id, site, external_id, company, company_norm, title, title_norm, location, description_text, requirements_text,
  url, posted_at, apply_type, apply_target, language, details_fetched, raw_json, content_hash, status, status_reason, prefilter_pass,
  prefilter_reason, duplicate_of, first_seen_at, last_seen_at, updated_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_dedupe ON jobs(company_norm, title_norm, first_seen_at);

ALTER TABLE scores ADD COLUMN required_years_min REAL;
ALTER TABLE scores ADD COLUMN required_years_quote TEXT;
ALTER TABLE scores ADD COLUMN seniority TEXT;          -- junior | mid | senior | unknown (LLM)
ALTER TABLE scores ADD COLUMN role_type TEXT;          -- role type the job was scored for
