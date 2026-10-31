import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const EnvSchema = z.object({
  DATA_DIR: z.string().default('data'),
  PREFERENCES_FILE: z.string().default('preferences.yaml'),
  PORT: int(8787),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  DRY_RUN: bool(true),
  HEADLESS: bool(false),

  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL_ANALYZE: z.string().default('gemma4:12b'),
  OLLAMA_MODEL_WRITE: z.string().default('gemma4:12b'),
  OLLAMA_TIMEOUT_MS: int(180_000),
  BENCH_MODELS: z.string().default('gemma4:12b'),

  MAX_PAGES_PER_RUN: int(3),
  DAILY_APPLY_LIMIT: int(15),
  AUTO_SUBMIT_MIN_SCORE: int(80),
  MATCH_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  COMPANY_COOLDOWN_DAYS: int(30),
  DEDUPE_WINDOW_DAYS: int(14),
  ENGLISH_CV_MAX_HEBREW_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  PACE_MIN_MS: int(2500),
  PACE_MAX_MS: int(7000),
});

export type Config = z.infer<typeof EnvSchema> & {
  dataDir: string;
  paths: {
    db: string;
    logs: string;
    screenshots: string;
    browserProfile: string;
    profileDir: string;
    investigations: string;
    reports: string;
    preferences: string;
  };
};

function load(): Config {
  const env = EnvSchema.parse(process.env);
  const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR);
  const paths = {
    db: path.join(dataDir, 'jobhunter.sqlite'),
    logs: path.join(dataDir, 'logs'),
    screenshots: path.join(dataDir, 'screenshots'),
    browserProfile: path.join(dataDir, 'browser-profile'),
    profileDir: path.join(dataDir, 'profile'),
    investigations: path.join(dataDir, 'investigations'),
    reports: path.join(dataDir, 'reports'),
    preferences: path.resolve(ROOT_DIR, env.PREFERENCES_FILE),
  };
  // `npm run doctor` sets JOBHUNTER_READONLY=1: report only, create nothing
  if (process.env.JOBHUNTER_READONLY !== '1') {
    for (const p of [dataDir, paths.logs, paths.screenshots, paths.browserProfile, paths.profileDir, paths.investigations, paths.reports]) {
      fs.mkdirSync(p, { recursive: true });
    }
  }
  return { ...env, dataDir, paths };
}

export const config = load();
export const READONLY = process.env.JOBHUNTER_READONLY === '1';
