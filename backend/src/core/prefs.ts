import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ROOT_DIR, config } from '../config.js';

const strList = z.array(z.string()).default([]);

export const PrefsSchema = z.object({
  queries: z
    .object({
      titles: strList,
      /** Optional extra keywords; each is searched as its own term. */
      keywords: strList,
    })
    .default({ titles: [], keywords: [] }),
  /** Accepted job locations (Hebrew or English). Empty = any. */
  locations: strList,
  filters: z
    .object({
      includeTitleKeywords: strList,
      excludeTitleKeywords: strList,
      excludeSeniorityKeywords: strList,
      excludeCompanies: strList,
      /** Location text that always passes the location filter (remote / nationwide). */
      remoteKeywords: strList,
    })
    .prefault({}),
  /**
   * Used by the scorer until data/profile/profile.json exists (Phase 2).
   * Only put true facts here.
   */
  candidateSummary: z.string().default(''),
  thresholds: z
    .object({
      autoSubmitMinScore: z.number().int().min(0).max(100).optional(),
      matchConfidence: z.number().min(0).max(1).optional(),
    })
    .prefault({}),
  limits: z
    .object({
      maxPagesPerRun: z.number().int().positive().optional(),
      dailyApplyLimit: z.number().int().nonnegative().optional(),
      companyCooldownDays: z.number().int().nonnegative().optional(),
    })
    .prefault({}),
  /** CV names exactly as they appear in the site's CV list (kept here, not .env, because of Hebrew). */
  cv: z.object({ he: z.string().default(''), en: z.string().default('') }).prefault({}),
  standardAnswers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type Prefs = z.infer<typeof PrefsSchema>;

export function loadPrefs(file = config.paths.preferences): Prefs {
  const fallback = path.join(ROOT_DIR, 'preferences.example.yaml');
  const src = fs.existsSync(file) ? file : fallback;
  if (!fs.existsSync(src)) return PrefsSchema.parse({});
  return PrefsSchema.parse(YAML.parse(fs.readFileSync(src, 'utf8')) ?? {});
}

export function searchTerms(p: Prefs): string[] {
  return [...new Set([...p.queries.titles, ...p.queries.keywords].map((s) => s.trim()).filter(Boolean))];
}

/** preferences.yaml overrides env for thresholds/limits. */
export function effectiveLimits(p: Prefs) {
  return {
    maxPagesPerRun: p.limits.maxPagesPerRun ?? config.MAX_PAGES_PER_RUN,
    dailyApplyLimit: p.limits.dailyApplyLimit ?? config.DAILY_APPLY_LIMIT,
    companyCooldownDays: p.limits.companyCooldownDays ?? config.COMPANY_COOLDOWN_DAYS,
    autoSubmitMinScore: p.thresholds.autoSubmitMinScore ?? config.AUTO_SUBMIT_MIN_SCORE,
    matchConfidence: p.thresholds.matchConfidence ?? config.MATCH_CONFIDENCE,
  };
}
