-- A send time, once set, never changes: an application's submitted_at, and a job's applied_manually_at ("I applied").
-- Any later UPDATE (an outcome, a dedupe, a re-check, a status reset, a migration that updates these rows) keeps the
-- first value; the rest of that UPDATE still applies. A migration that REBUILDS one of these tables must create these
-- triggers again (test/send-time.test.ts checks they exist).
CREATE TRIGGER IF NOT EXISTS applications_submitted_at_immutable
AFTER UPDATE OF submitted_at ON applications
WHEN OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at
BEGIN
  UPDATE applications SET submitted_at = OLD.submitted_at WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS jobs_applied_manually_at_immutable
AFTER UPDATE OF applied_manually_at ON jobs
WHEN OLD.applied_manually_at IS NOT NULL AND NEW.applied_manually_at IS NOT OLD.applied_manually_at
BEGIN
  UPDATE jobs SET applied_manually_at = OLD.applied_manually_at WHERE id = NEW.id;
END;
