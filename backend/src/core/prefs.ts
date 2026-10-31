import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ROOT_DIR, config } from '../config.js';

const strList = z.array(z.string()).default([]);

/** Title words that mark a role as too senior (whole-word, case-insensitive). */
export const DEFAULT_SENIORITY_EXCLUDES = [
  'Senior', 'Sr', 'Lead', 'Team Lead', 'Tech Lead', 'Principal', 'Staff', 'Architect', 'Head of', 'Manager', 'Director',
  'בכיר', 'בכירה', 'ראש צוות', 'ארכיטקט', 'מנהל פיתוח',
];

/** Salary settings; every value optional and empty by default (empty = fall back to the tier, then the default). */
export const SalarySettingsSchema = z
  .object({
    /** minimum acceptable monthly gross (ILS); empty = no salary filtering */
    floor: z.number().nonnegative().nullable().optional(),
    /** answer to a text salary question when the job posts no range */
    textAnswerNoRange: z.string().nullable().optional(),
    /** answer to a number-only salary field when the job posts no range */
    numericFallback: z.number().nonnegative().nullable().optional(),
  })
  .prefault({});

export const RoleTypeSchema = z.object({
  id: z.string().min(1),
  /** shown in the UI and given to the scorer; defaults to id */
  label: z.string().optional(),
  /** 1 = core, 2 = good, 3 = fallback */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  enabled: z.boolean().default(true),
  /** search-only (e.g. "junior"): its queries are searched, but it never decides a job's tier/role or its title keywords */
  searchOnly: z.boolean().default(false),
  /** search terms (Hebrew + English); each is searched on every site */
  queries: strList,
  /** a job title must contain one of these (whole words) for the job to count as this role type */
  titleKeywords: strList,
  /** extra guidance for the scorer, e.g. "development-oriented only" */
  notes: z.string().optional(),
  /**
   * seniority words that do NOT skip a job whose title matches this role type's titleKeywords, e.g. ["מוביל",
   * "AI Lead", "Innovation Lead"]. "מוביל" covers מוביל/ה, מוביל/ת, מובילה (never as a team lead: "מוביל/ת צוות").
   */
  allowSeniorityWords: strList,
  /** salary settings for this role type (empty values fall back to the tier, then the default) */
  salary: SalarySettingsSchema.optional(),
});
export type RoleType = z.infer<typeof RoleTypeSchema>;

export const PrefsSchema = z.object({
  roleTypes: z.array(RoleTypeSchema).default([]),
  /** Legacy single query list (used only when roleTypes is empty). */
  queries: z
    .object({
      titles: strList,
      keywords: strList,
    })
    .default({ titles: [], keywords: [] }),
  /** Accepted job locations (Hebrew or English). Empty = any. */
  locations: strList,
  filters: z
    .object({
      /** extra title keywords, in addition to every enabled role type's titleKeywords */
      includeTitleKeywords: strList,
      excludeTitleKeywords: strList,
      excludeSeniorityKeywords: z.array(z.string()).default(DEFAULT_SENIORITY_EXCLUDES),
      excludeCompanies: strList,
      /** Location text that always passes the location filter (remote / nationwide). */
      remoteKeywords: strList,
    })
    .prefault({}),
  /** Jobs requiring more years than this are skipped (status skipped_experience). */
  maxRequiredYears: z.number().nonnegative().default(3),
  ranking: z
    .object({
      experienceBoost: z
        .object({
          /** junior / entry-level / ללא ניסיון / בוגרי קורס / סטודנטים / 0–1 years */
          junior: z.number().default(15),
          years2: z.number().default(5),
          years3: z.number().default(-10),
          /** only reachable if maxRequiredYears > 3 */
          above3: z.number().default(-20),
          unknown: z.number().default(0),
        })
        .prefault({}),
      tierBoost: z.object({ tier1: z.number().default(5), tier2: z.number().default(0), tier3: z.number().default(-25) }).prefault({}),
      /** added when the posted monthly range reaches the role type's salary floor (0 = off) */
      salaryBoost: z.number().default(0),
    })
    .prefault({}),
  /** Salary settings per tier and default; a role type's own `salary` wins (see core/salary.ts). */
  salary: z
    .object({ default: SalarySettingsSchema, tier1: SalarySettingsSchema, tier2: SalarySettingsSchema, tier3: SalarySettingsSchema })
    .prefault({}),
  /** Used by the scorer only until data/profile/profile.json exists. True facts only. */
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
  cv: z
    .object({
      he: z.string().default(''),
      en: z.string().default(''),
      /** English CV only when Hebrew letters are below this share of the post (overrides ENGLISH_CV_MAX_HEBREW_RATIO) */
      englishMaxHebrewRatio: z.number().min(0).max(1).optional(),
    })
    .prefault({}),
  /** JobMaster: the CV files in your JobMaster account (exact file names), and the account's contact-details question */
  jobmaster: z
    .object({
      /** chosen by the same language rule as cv.he / cv.en; a missing name means the application fails (no fallback) */
      cv: z.object({ he: z.string().default(''), en: z.string().default('') }).prefault({}),
      /** "expose your contact details to recruiters in the profile database?" — answered with this, default no */
      shareContactDetails: z.boolean().default(false),
    })
    .prefault({}),
  /** Jobnet: the CV files saved in your Jobnet account, and which Jobnet regions count as your locations */
  jobnet: z
    .object({
      /** chosen by the same language rule as cv.he / cv.en; a missing name means the application fails (no fallback) */
      cv: z.object({ he: z.string().default(''), en: z.string().default('') }).prefault({}),
      /**
       * Jobnet gives regions (מרכז, שרון, השפלה…), not the job's city: a job in one of these regions passes the location
       * filter (marked "location approximate"). Empty = match the region's sub-areas against your locations instead.
       */
      regions: z.array(z.string()).default([]),
    })
    .prefault({}),
  standardAnswers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type Prefs = z.infer<typeof PrefsSchema>;

export function loadPrefs(file = config.paths.preferences): Prefs {
  const fallback = path.join(ROOT_DIR, 'preferences.example.yaml');
  const src = fs.existsSync(file) ? file : fallback;
  if (!fs.existsSync(src)) return PrefsSchema.parse({});
  return PrefsSchema.parse(YAML.parse(fs.readFileSync(src, 'utf8')) ?? {});
}

/** Enabled role types; the legacy `queries` list becomes one tier-1 role type when none are configured. */
export function activeRoleTypes(p: Pick<Prefs, 'roleTypes' | 'queries'>): RoleType[] {
  if (p.roleTypes.length > 0) return p.roleTypes.filter((r) => r.enabled);
  const legacy = [...p.queries.titles, ...p.queries.keywords];
  return legacy.length ? [{ id: 'default', tier: 1, enabled: true, searchOnly: false, queries: legacy, titleKeywords: [], allowSeniorityWords: [] }] : [];
}

/** Unique search terms with the role types that asked for them (a term shared by two roles is searched once). */
export function searchPlan(p: Prefs): Array<{ query: string; roleIds: string[] }> {
  const byQuery = new Map<string, string[]>();
  for (const r of activeRoleTypes(p)) {
    for (const q of r.queries.map((s) => s.trim()).filter(Boolean)) {
      const key = q.toLowerCase();
      byQuery.set(key, [...(byQuery.get(key) ?? []), r.id]);
    }
  }
  const original = new Map(activeRoleTypes(p).flatMap((r) => r.queries.map((q) => [q.trim().toLowerCase(), q.trim()] as const)));
  return [...byQuery.entries()].map(([k, roleIds]) => ({ query: original.get(k) ?? k, roleIds: [...new Set(roleIds)] }));
}

/** Kept for callers that only need the terms. */
export const searchTerms = (p: Prefs): string[] => searchPlan(p).map((s) => s.query);

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
