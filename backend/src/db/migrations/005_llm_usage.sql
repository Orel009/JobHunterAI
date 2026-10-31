-- Token usage per day / provider / model (API providers count toward DAILY_LLM_TOKEN_LIMIT).
CREATE TABLE llm_usage (
  day           TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);
