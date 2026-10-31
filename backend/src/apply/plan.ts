import type { DB } from '../db/index.js';
import { cvNamesFor } from './cv-names.js';
import { nowIso } from '../db/index.js';
import { config } from '../config.js';
import type { Prefs } from '../core/prefs.js';
import { effectiveLimits } from '../core/prefs.js';
import type { Repo, StoredJob } from '../db/repo.js';
import { loadProfile } from '../profile/facts.js';
import { AnswersBank, bankTypeFor, yesNo } from './bank.js';
import { chooseCv } from './cv.js';
import { makeBankMatcher, makeDrafter, makeYearsClassifier } from './draft.js';
import { resolveField, type ResolveDeps } from './resolve.js';
import { salarySettings, type PostedSalary } from '../core/salary.js';
import { scoringRole } from '../core/prefilter.js';
import type { ApplyPlan, CvChoice, FormField, ResolvedField } from './types.js';

/**
 * Statement-style screening questions ("I confirm…") must be true for the candidate to tick them. A site's own
 * question with a yes/no answer (JobMaster suitability.*) is a question: "no" is a valid, honest answer.
 */
export const isConfirmation = (f: FormField) => f.type === 'consent' || (f.type === 'yes_no' && !f.key.startsWith('suitability.'));

export function readiness(fields: ResolvedField[]): ApplyPlan['readiness'] {
  if (fields.some((r) => r.field.required && isConfirmation(r.field) && r.status === 'resolved' && yesNo(r.value) === 'no')) return 'blocked_no';
  if (fields.some((r) => r.status === 'pending')) return 'needs_answers';
  if (fields.some((r) => r.status === 'draft')) return 'has_drafts';
  return 'ready';
}

export interface PlanContext {
  db: DB;
  repo: Repo;
  prefs: Prefs;
  /** test seam */
  deps?: Partial<ResolveDeps>;
}

/**
 * Resolves every field, stores pending questions in the answers bank, and returns the plan.
 * Fields come from the site adapter (live panel) or, before the panel is read, from the job data.
 */
/** The job's posted salary + the settings of the role type it is ranked as (for salary questions). */
export function jobSalaryContext(job: StoredJob, prefs: Prefs): NonNullable<ResolveDeps['salary']> {
  const posted: PostedSalary | null =
    job.salaryUnit && (job.salaryMin !== null || job.salaryMax !== null)
      ? { min: job.salaryMin, max: job.salaryMax, unit: job.salaryUnit, source: job.salarySource ?? 'description', text: job.salaryText ?? '' }
      : null;
  return { posted, settings: salarySettings(prefs, scoringRole(job, prefs)) };
}

export async function buildPlan(job: StoredJob, fields: FormField[], ctx: PlanContext, cvOverride?: CvChoice | null): Promise<ApplyPlan> {
  const bank = new AnswersBank(ctx.db);
  const profile = ctx.deps?.profile !== undefined ? ctx.deps.profile : loadProfile();
  const jobText = `${job.title}\n${job.descriptionText}\n${job.requirementsText}`;
  const deps: ResolveDeps = {
    profile,
    bank,
    matchBank: makeBankMatcher({ cache: ctx.repo }),
    draft: makeDrafter(profile, { cache: ctx.repo }),
    classifyYears: makeYearsClassifier({ cache: ctx.repo }),
    minConfidence: effectiveLimits(ctx.prefs).matchConfidence,
    job: { title: job.title, text: jobText, language: job.language },
    salary: jobSalaryContext(job, ctx.prefs),
    ...ctx.deps,
  };
  const resolved: ResolvedField[] = [];
  for (const f of fields) {
    const r = await resolveField(f, deps);
    if (r.status === 'pending') bank.addPending(f.label, bankTypeFor(f.type), f.options ?? null);
    if (r.provenance.source === 'bank' && r.provenance.ref) bank.markUsed(Number(r.provenance.ref));
    resolved.push(r);
  }
  const notes: string[] = [];
  let cv: CvChoice | null = cvOverride ?? null;
  if (!cv) {
    const names = cvNamesFor(job.site, ctx.prefs);
    if (!names.he || !names.en) notes.push(`${names.where} is not set (both names are needed for the language rule)`);
    else cv = chooseCv(job, names, ctx.prefs.cv.englishMaxHebrewRatio ?? config.ENGLISH_CV_MAX_HEBREW_RATIO);
  }
  return { jobId: job.id, site: job.site, createdAt: nowIso(), cv, fields: resolved, readiness: readiness(resolved), notes };
}

/** Fields known from Drushim job data before the apply panel is opened: screening statements (+ consent, added live). */
export function drushimFieldsFromJob(job: StoredJob): FormField[] {
  const raw = job.raw as { filterQuestions?: unknown[] } | null;
  const qs = (raw?.filterQuestions ?? []).filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
  return qs.map((q, i) => ({ key: `screening.${i}`, label: q.trim(), type: 'yes_no' as const, required: true }));
}

// ---------- applications ----------
export type AppStatus = 'needs_review' | 'ready' | 'approved' | 'dry_run_ok' | 'submitted' | 'skipped' | 'failed' | 'blocked' | 'rejected';

export interface ApplicationRow {
  id: number;
  jobId: string;
  site: string;
  companyNorm: string;
  status: AppStatus;
  dryRun: boolean;
  plan: ApplyPlan;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  confirmationText: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  /** the auto-submit gate result (core of History's "conditions checked"), null = never evaluated */
  gate: unknown;
}

interface AppDbRow {
  id: number;
  job_id: string;
  site: string;
  company_norm: string;
  status: string;
  dry_run: number;
  plan_json: string;
  screenshot_before: string | null;
  screenshot_after: string | null;
  confirmation_text: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  gate_json: string | null;
}

const appFromRow = (r: AppDbRow): ApplicationRow => ({
  id: r.id,
  jobId: r.job_id,
  site: r.site,
  companyNorm: r.company_norm,
  status: r.status as AppStatus,
  dryRun: !!r.dry_run,
  plan: JSON.parse(r.plan_json) as ApplyPlan,
  screenshotBefore: r.screenshot_before,
  screenshotAfter: r.screenshot_after,
  confirmationText: r.confirmation_text,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  submittedAt: r.submitted_at,
  reviewedAt: r.reviewed_at,
  gate: r.gate_json ? (JSON.parse(r.gate_json) as unknown) : null,
});

export class Applications {
  constructor(private db: DB) {}

  get(id: number): ApplicationRow | null {
    const r = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as AppDbRow | undefined;
    return r ? appFromRow(r) : null;
  }

  latestForJob(jobId: string): ApplicationRow | null {
    const r = this.db.prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId) as AppDbRow | undefined;
    return r ? appFromRow(r) : null;
  }

  list(statuses?: AppStatus[]): ApplicationRow[] {
    const rows = (
      statuses?.length
        ? this.db.prepare(`SELECT * FROM applications WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id DESC`).all(...statuses)
        : this.db.prepare('SELECT * FROM applications ORDER BY id DESC LIMIT 500').all()
    ) as unknown as AppDbRow[];
    return rows.map(appFromRow);
  }

  /** Creates or replaces the open (not yet submitted) application of a job. */
  savePlan(job: StoredJob, plan: ApplyPlan, status: AppStatus): ApplicationRow {
    const now = nowIso();
    const open = this.db
      .prepare(`SELECT id FROM applications WHERE job_id = ? AND status NOT IN ('submitted','skipped','rejected') ORDER BY id DESC LIMIT 1`)
      .get(job.id) as { id: number } | undefined;
    if (open) {
      this.db.prepare('UPDATE applications SET plan_json = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), status, now, open.id);
      return this.get(open.id)!;
    }
    const r = this.db
      .prepare(`INSERT INTO applications (job_id, site, company_norm, status, dry_run, plan_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(job.id, job.site, job.companyNorm, status, config.DRY_RUN ? 1 : 0, JSON.stringify(plan), now, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  update(id: number, patch: Partial<Pick<ApplicationRow, 'status' | 'screenshotBefore' | 'screenshotAfter' | 'confirmationText' | 'error' | 'plan' | 'dryRun' | 'gate'>> & { submitted?: boolean; reviewed?: boolean }): void {
    const cur = this.get(id);
    if (!cur) return;
    const now = nowIso();
    if (patch.gate !== undefined) this.db.prepare('UPDATE applications SET gate_json = ? WHERE id = ?').run(patch.gate === null ? null : JSON.stringify(patch.gate), id);
    this.db
      .prepare(
        `UPDATE applications SET status = ?, screenshot_before = ?, screenshot_after = ?, confirmation_text = ?, error = ?, plan_json = ?, dry_run = ?,
           submitted_at = CASE WHEN ? THEN ? ELSE submitted_at END, reviewed_at = CASE WHEN ? THEN ? ELSE reviewed_at END, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.screenshotBefore ?? cur.screenshotBefore,
        patch.screenshotAfter ?? cur.screenshotAfter,
        patch.confirmationText ?? cur.confirmationText,
        patch.error === undefined ? cur.error : patch.error,
        JSON.stringify(patch.plan ?? cur.plan),
        (patch.dryRun ?? cur.dryRun) ? 1 : 0,
        patch.submitted ? 1 : 0,
        now,
        patch.reviewed ? 1 : 0,
        now,
        now,
        id,
      );
  }

  /** How many open applications each pending bank question blocks (by normalized key). */
  pendingBlockCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const a of this.list(['needs_review', 'ready'])) {
      for (const f of a.plan.fields) if (f.status === 'pending') counts.set(f.normKey, (counts.get(f.normKey) ?? 0) + 1);
    }
    return counts;
  }

  /** Real (non-dry-run) submissions to a company within the cooldown window. */
  recentlyAppliedToCompany(companyNorm: string, days: number): boolean {
    if (!companyNorm) return false;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return !!this.db.prepare(`SELECT 1 FROM applications WHERE company_norm = ? AND status = 'submitted' AND dry_run = 0 AND submitted_at >= ? LIMIT 1`).get(companyNorm, since);
  }
}
