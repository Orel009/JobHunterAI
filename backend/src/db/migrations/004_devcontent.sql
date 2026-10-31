-- Tier-3 ranking uses the share of real development work; training programs are not jobs.
ALTER TABLE scores ADD COLUMN dev_content_score INTEGER;
ALTER TABLE scores ADD COLUMN is_training_program INTEGER;
