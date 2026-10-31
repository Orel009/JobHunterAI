-- One row per hunt (manual, in-app schedule, Windows Task Scheduler): its summary for the dashboard.
CREATE TABLE hunts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger      TEXT NOT NULL,                -- manual | schedule | task | cli
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}'
);
