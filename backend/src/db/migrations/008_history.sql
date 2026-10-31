-- History: your own outcome tracking per application (keyed by job: LinkedIn "I applied" jobs have no application row).
CREATE TABLE application_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  outcome     TEXT NOT NULL,       -- no_response | screening_call | interview | home_assignment | offer | rejected | withdrawn
  changed_on  TEXT NOT NULL,       -- the date of the change (YYYY-MM-DD), yours to set
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_outcomes_job ON application_outcomes(job_id, changed_on);

CREATE TABLE application_notes (
  job_id      TEXT PRIMARY KEY REFERENCES jobs(id),
  notes       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);
