-- LinkedIn job alerts (email): which alert emails were already imported, and manual applications.
CREATE TABLE email_processed (
  message_id   TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  received_at  TEXT,
  processed_at TEXT NOT NULL,
  jobs_found   INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE jobs ADD COLUMN applied_manually_at TEXT;   -- set by "I applied" (status submitted_manual)
