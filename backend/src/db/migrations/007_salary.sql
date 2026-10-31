-- Posted salary per job (deterministic; see core/salary.ts). Monthly gross ILS unless salary_unit = 'hour'.
ALTER TABLE jobs ADD COLUMN salary_min INTEGER;
ALTER TABLE jobs ADD COLUMN salary_max INTEGER;
ALTER TABLE jobs ADD COLUMN salary_unit TEXT;          -- month | hour
ALTER TABLE jobs ADD COLUMN salary_source TEXT;        -- drushim_field | description | drushim_bucket
ALTER TABLE jobs ADD COLUMN salary_text TEXT;          -- the text it was read from (provenance)
ALTER TABLE jobs ADD COLUMN salary_hash TEXT;          -- content_hash the salary was read from (re-read when it changes)
