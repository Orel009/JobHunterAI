/**
 * Auto-submit — OFF by default, per site. A prepared application is sent without your review ONLY when every gate
 * condition holds; anything else goes to the review queue as before. The gate result (every condition, passed or
 * not) is stored on the application and shown in History. A kill switch pauses it for all sites at once, and it is
 * checked again right before the final click.
 */
import { config } from '../config.js';
import { hasApplyFlow } from './drivers.js';
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { Repo, StoredJob } from '../db/repo.js';
import { readSettingsFile, writeSettingsFile } from '../llm/settings.js';
import { effectiveLimits, type Prefs } from '../core/prefs.js';
import { excludedCompanyMatch, rolesMatchingTitle, scoringRole } from '../core/prefilter.js';
import { rankStoredJob } from '../core/rank.js';
import { isAnonymousCompany } from '../core/text.js';
import type { ApplyPlan } from './types.js';

// ---------- settings (data/settings.json) ----------
export interface AutoSubmitSettings {
  /** per site; missing = off */
  sites: Record<string, boolean>;
  /** null = AUTO_SUBMIT_MIN_RANK from .env (default 90) */
  minRank: number | null;
  /** kill switch: true stops auto-submit for every site until resumed */
  paused: boolean;
  pausedAt: string | null;
}

export function autoSubmitSettings(): AutoSubmitSettings {
  const s = (readSettingsFile() as { autoSubmit?: Partial<AutoSubmitSettings> }).autoSubmit ?? {};
  return {
    sites: Object.fromEntries(Object.entries(s.sites ?? {}).filter(([, v]) => v === true)) as Record<string, boolean>,
    minRank: typeof s.minRank === 'number' && Number.isFinite(s.minRank) ? s.minRank : null,
    paused: s.paused === true,
    pausedAt: s.pausedAt ?? null,
  };
}

export function saveAutoSubmitSettings(patch: Partial<AutoSubmitSettings>): AutoSubmitSettings {
  const file = readSettingsFile();
  const next = { ...autoSubmitSettings(), ...patch };
  writeSettingsFile({ ...file, autoSubmit: next } as typeof file);
  return autoSubmitSettings();
}

export const effectiveMinRank = (s = autoSubmitSettings()) => s.minRank ?? config.AUTO_SUBMIT_MIN_RANK;
export const autoSubmitOn = (site: string, s = autoSubmitSettings()) => s.sites[site] === true && !s.paused;

export function pauseAutoSubmit(): AutoSubmitSettings {
  return saveAutoSubmitSettings({ paused: true, pausedAt: nowIso() });
}

// ---------- the gate ----------
export interface GateCondition {
  name: string;
  ok: boolean;
  detail: string;
}
export interface GateResult {
  /** true = this application was (or may be) sent automatically */
  auto: boolean;
  at: string;
  conditions: GateCondition[];
}

export interface GateInput {
  dryRun: boolean;
  /** role types of this job set to "never auto-submit" (Preferences); any → the job waits for your approval */
  neverAutoRoles?: string[];
  site: string;
  siteEnabled: boolean;
  paused: boolean;
  automatedFlow: boolean;
  rank: number | null;
  minRank: number;
  plan: ApplyPlan;
  descriptionText: string;
  company: string;
  companyNorm: string;
  cooldownDays: number;
  recentlyAppliedToCompany: boolean;
  excludedMatch: string | null;
  submittedToday: number;
  dailyLimit: number;
}

/** answers that may be sent without review: from the profile / bank / computed from them, never written by the model */
const OWN_SOURCES = new Set(['profile', 'bank', 'skill_years', 'declared_experience', 'salary', 'user']);

export function autoSubmitGate(i: GateInput, now = new Date()): GateResult {
  const notOwn = i.plan.fields.filter(
    (f) =>
      f.status === 'pending' ||
      f.status === 'draft' ||
      (f.status === 'resolved' && (!OWN_SOURCES.has(f.provenance.source) || (f.provenance.source === 'bank' && (f.provenance.confidence ?? 0) < 1))),
  );
  const conditions: GateCondition[] = [
    { name: 'DRY_RUN is off', ok: !i.dryRun, detail: i.dryRun ? 'DRY_RUN=true: nothing is ever sent' : 'DRY_RUN=false' },
    { name: `auto-submit is on for ${i.site}`, ok: i.siteEnabled, detail: i.siteEnabled ? 'on (Settings)' : 'off (Settings)' },
    { name: 'not paused', ok: !i.paused, detail: i.paused ? 'paused with "Pause auto-submit"' : 'running' },
    { name: 'the site has an automated apply flow', ok: i.automatedFlow, detail: i.automatedFlow ? i.site : `${i.site}: applied to by hand or via an external link` },
    {
      name: 'its role type allows auto-submit',
      ok: !i.neverAutoRoles?.length,
      detail: i.neverAutoRoles?.length ? `role type ${i.neverAutoRoles.join(', ')}: never auto-submitted (Preferences) — waits for your approval` : 'allowed',
    },
    { name: `rank ≥ ${i.minRank}`, ok: i.rank !== null && i.rank >= i.minRank, detail: `rank ${i.rank ?? 'none (not scored)'}` },
    {
      name: 'every answer from your profile / answers bank (no drafts, nothing pending, nothing written by the model)',
      ok: notOwn.length === 0 && !!i.plan.cv && i.plan.readiness === 'ready',
      detail: !i.plan.cv
        ? 'no CV chosen'
        : notOwn.length
          ? notOwn
              .map((f) => `"${f.field.label}": ${f.status === 'resolved' ? (f.provenance.source === 'bank' ? 'bank answer matched by the model, not exactly' : f.provenance.source) : f.status}`)
              .join('; ')
          : i.plan.readiness !== 'ready'
            ? `plan is ${i.plan.readiness}`
            : `${i.plan.fields.length} field(s), CV "${i.plan.cv.cvName}"`,
    },
    {
      name: `no application to this company in ${i.cooldownDays} days`,
      ok: !!i.companyNorm && !isAnonymousCompany(i.companyNorm) && !i.recentlyAppliedToCompany,
      detail: !i.companyNorm || isAnonymousCompany(i.companyNorm) ? `company "${i.company}" is confidential: the cooldown cannot be checked` : i.recentlyAppliedToCompany ? `already applied to ${i.company} recently` : i.company,
    },
    { name: 'company not on your excluded list', ok: !i.excludedMatch, detail: i.excludedMatch ? `matches "${i.excludedMatch}"` : i.company },
    { name: `under today's limit for ${i.site}`, ok: i.submittedToday < i.dailyLimit, detail: `${i.submittedToday} of ${i.dailyLimit} sent today` },
    { name: 'full job description (not "incomplete info")', ok: !!i.descriptionText.trim(), detail: i.descriptionText.trim() ? `${i.descriptionText.length} characters` : 'only title / company / location known' },
  ];
  return { auto: conditions.every((c) => c.ok), at: now.toISOString(), conditions };
}

/** The gate for a prepared application, from the live settings and the database. */
export function evaluateAutoSubmit(db: DB, repo: Repo, job: StoredJob, plan: ApplyPlan, prefs: Prefs): GateResult {
  const s = autoSubmitSettings();
  const limits = effectiveLimits(prefs);
  const since = new Date(Date.now() - limits.companyCooldownDays * 86_400_000).toISOString();
  const recent = !!db
    .prepare(
      `SELECT 1 FROM applications WHERE company_norm = ? AND status = 'submitted' AND dry_run = 0 AND submitted_at >= ?
       UNION SELECT 1 FROM jobs WHERE company_norm = ? AND status = 'submitted_manual' AND applied_manually_at >= ? LIMIT 1`,
    )
    .get(job.companyNorm, since, job.companyNorm, since);
  // the role type it is judged as, and every role type its title matches: any "never auto-submit" one keeps it in review
  const roles = [scoringRole(job, prefs), ...rolesMatchingTitle(job.title, prefs.roleTypes)].filter((r) => r?.neverAutoSubmit);
  return autoSubmitGate({
    dryRun: config.DRY_RUN,
    neverAutoRoles: [...new Set(roles.map((r) => r!.id))],
    site: job.site,
    siteEnabled: s.sites[job.site] === true,
    paused: s.paused,
    automatedFlow: hasApplyFlow(job.site) && job.applyType !== 'external' && job.applyType !== 'email',
    rank: rankStoredJob(job, repo.getScore(job.id), prefs).rank,
    minRank: effectiveMinRank(s),
    plan,
    descriptionText: job.descriptionText,
    company: job.company,
    companyNorm: job.companyNorm,
    cooldownDays: limits.companyCooldownDays,
    recentlyAppliedToCompany: recent,
    excludedMatch: excludedCompanyMatch(job.company, prefs.filters.excludeCompanies),
    submittedToday: repo.submittedToday(job.site),
    dailyLimit: limits.dailyApplyLimit,
  });
}
