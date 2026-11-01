/**
 * Apply orchestration, for every site with an automated apply flow (Drushim, JobMaster — see drivers.ts):
 *   prepare(jobs) → open panel, read fields, build plan, tick only confirmed items, screenshot, stop → needs_review
 *   approve(app)  → DRY_RUN: fill everything, screenshot, stop → dry_run_ok
 *                   DRY_RUN=false: fill, screenshot, submit, capture confirmation → submitted / skipped / failed
 * There is no auto-submit in this phase: real submission only happens from an explicit approval.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { Repo, type StoredJob } from '../db/repo.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { candidateGender } from '../profile/facts.js';
import { rankStoredJob } from '../core/rank.js';
import { BlockedError, getPage, pace } from '../browser/session.js';
import type { Page } from 'playwright';
import type { log } from '../log.js';
import { startTask } from '../pipeline/runner.js';
import { ApplyError, type PanelState } from '../sites/apply-error.js';
import { driverFor, type ApplyDriver, type SubmitResult } from './drivers.js';
import { cvNamesFor } from './cv-names.js';
import { AnswersBank, bankTypeFor, yesNo } from './bank.js';
import { hebrewRatio } from './cv.js';
import { Applications, buildPlan, isConfirmation, readiness, type ApplicationRow, type AppStatus } from './plan.js';
import type { JobStatus } from '../sites/types.js';
import { autoSubmitOn, evaluateAutoSubmit } from './auto-submit.js';
import { getSession, setSession } from '../browser/site-session.js';
import { excludedCompanyMatch } from '../core/prefilter.js';
import type { ApplyPlan, ResolvedField } from './types.js';
import { isAssistedSite } from '../alerts/assisted.js';
import { isPaused, pauseSite, pausedText } from '../core/site-pause.js';
import { BudgetError, noteSendCaptcha } from '../core/site-budget.js';
import { SITES } from '../sites/registry.js';

const siteName = (site: string) => SITES.find((s) => s.id === site)?.displayName ?? site;

export class ServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const OPEN = ['needs_review', 'ready', 'dry_run_ok', 'failed'] as const;

function savePlanFile(appId: number, plan: ApplyPlan): string {
  const file = `app${appId}-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(config.paths.screenshots, file), JSON.stringify(plan, null, 2));
  return file;
}

/**
 * Fills what is already answered and selects the CV — for the prepare screenshot (never submits): confirmations only
 * when they are "yes", other questions only when resolved.
 */
async function partialFill(driver: ApplyDriver, page: Page, state: PanelState, plan: ApplyPlan) {
  const subset: PanelState = {
    ...state,
    fields: state.fields.filter((f) => {
      const p = plan.fields.find((x) => x.field.key === f.key);
      if (isConfirmation(f)) return p?.status === 'resolved' && yesNo(p.value) === 'yes';
      return f.key.startsWith('suitability.') ? p?.status === 'resolved' : true;
    }),
  };
  await driver.fillPanel(page, subset, plan);
}

/** One task label for a set of jobs: their site, or "apply" when they span sites. */
const taskSite = (sites: string[]) => (new Set(sites).size === 1 ? sites[0]! : 'apply');

// ---------- prepare ----------
/** An application done by hand (a company / ATS link, an email address): to the review queue with the link. */
function queueManualApplication(apps: Applications, repo: Repo, job: StoredJob): void {
  const plan: ApplyPlan = { jobId: job.id, site: job.site, createdAt: new Date().toISOString(), cv: null, fields: [], readiness: 'needs_answers', notes: [`${job.applyType} apply → ${job.applyTarget} (handled manually in this phase)`] };
  apps.savePlan(job, plan, 'needs_review');
  repo.setStatus(job.id, 'needs_review', `${job.applyType} apply`);
}

/**
 * Apply errors that close a job without failing it: already applied, no longer current, answers the employer does not
 * accept, and a company-site link (→ the review queue with the link, no automation). Null = a real failure.
 */
function closeOnApplyError(apps: Applications, repo: Repo, job: StoredJob, appId: number | null, e: unknown): { status: string; detail: string } | null {
  if (!(e instanceof ApplyError)) return null;
  const close = (jobStatus: JobStatus, reason: string, appStatus: AppStatus = 'skipped') => {
    repo.setStatus(job.id, jobStatus, reason);
    const app = appId !== null ? apps.get(appId) : apps.latestForJob(job.id);
    if (app && app.status !== 'submitted') apps.update(app.id, { status: appStatus, error: reason });
    return { status: 'skipped', detail: reason };
  };
  if (e.code === 'already_applied') return close('skipped', `already_applied: ${e.message}`);
  if (e.code === 'expired') return close('skipped', `expired: ${e.message}`);
  if (e.code === 'screening_mismatch') return close('skipped_screening', `the employer does not accept your answer: ${e.message}`);
  if (e.code === 'external_apply') {
    const app = appId !== null ? apps.get(appId) : apps.latestForJob(job.id);
    if (app && app.status !== 'submitted') apps.update(app.id, { status: 'skipped', error: `applies on the company's site: ${e.message}` });
    repo.setExternalApply(job.id, e.message);
    queueManualApplication(apps, repo, repo.getJob(job.id)!);
    return { status: 'needs_review', detail: `applies on the company's site — in the review queue with the link (${e.message})` };
  }
  return null;
}

/**
 * Scored jobs from alert emails whose link leads to a company / ATS page (score ≥ the threshold, nothing done with
 * them yet) → the review queue with that link. No browser: nothing is opened or filled.
 */
export function queueExternalForReview(db: DB, site: string, minScore: number): number {
  const repo = new Repo(db);
  const apps = new Applications(db);
  let n = 0;
  for (const j of repo.listJobs({ site, status: 'scored', minScore, limit: 2000 }).items) {
    if (j.applyType !== 'external' || !j.applyTarget || apps.latestForJob(j.id)) continue;
    queueManualApplication(apps, repo, repo.getJob(j.id)!);
    n++;
  }
  return n;
}

export function prepareJobs(db: DB, jobIds: string[]): number {
  const repo = new Repo(db);
  const apps = new Applications(db);
  const prefsNow = loadPrefs();
  // highest rank first, so the daily limit is spent on the best jobs
  let jobs = jobIds
    .map((id) => repo.getJob(id))
    .filter((j): j is StoredJob => !!j)
    .map((j) => ({ j, r: rankStoredJob(j, repo.getScore(j.id), prefsNow).rank ?? -Infinity }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.j);
  if (jobs.length === 0) throw new ServiceError(404, 'no such jobs');
  // a paused site is not loaded at all: its jobs stay where they are (company-site / email jobs need no site load)
  const loadsSite = (j: StoredJob) => j.applyType !== 'external' && j.applyType !== 'email';
  const pausedJobs = jobs.filter((j) => loadsSite(j) && isPaused(j.site));
  if (pausedJobs.length === jobs.length) throw new ServiceError(409, pausedText(pausedJobs[0]!.site, siteName(pausedJobs[0]!.site))!);
  jobs = jobs.filter((j) => !pausedJobs.includes(j));
  // LinkedIn / Indeed are assisted-only: their jobs reach the review queue only with a company / ATS link
  if (jobs.some((j) => isAssistedSite(j.site) && !(j.applyType === 'external' && j.applyTarget))) {
    throw new ServiceError(400, 'LinkedIn / Indeed jobs are applied to by hand: use the Email alerts screen (Open in my browser)');
  }
  for (const j of jobs) repo.setStatus(j.id, 'queued', 'preparing application');

  return startTask(db, taskSite(jobs.map((j) => j.site)), 'prepare', async (run, _repo, L) => {
    const prefs = loadPrefs();
    new AnswersBank(db).seed(prefs, candidateGender());
    run.stats.prepared = 0;
    // each site's own list of jobs this account applied to, read once per run
    const applied = new Map<string, Map<string, string | null> | null>();
    for (const site of new Set(jobs.filter((j) => j.applyType !== 'external' && j.applyType !== 'email' && driverFor(j.site)).map((j) => j.site))) {
      const list = await driverFor(site)!
        .fetchAppliedJobs(await getPage())
        .catch((e: unknown) => {
          L.warn({ site, err: e instanceof Error ? e.message : String(e) }, 'could not read the already-applied list; each job page is still checked');
          return null;
        });
      applied.set(site, list);
      if (list) run.stats.alreadyApplied = (run.stats.alreadyApplied ?? 0) + repo.markAlreadyApplied(site, list);
    }
    for (const job of jobs) {
      if (run.controller.signal.aborted) return;
      if (applied.get(job.site)?.has(job.externalId)) continue; // skipped already_applied above
      run.stage = `preparing ${job.title}`;
      if (job.applyType === 'external' || job.applyType === 'email') {
        queueManualApplication(apps, repo, job);
        continue;
      }
      const driver = driverFor(job.site);
      if (!driver) {
        repo.setStatus(job.id, 'failed', `no apply flow for ${job.site} yet`);
        continue;
      }
      if (isPaused(job.site)) {
        // paused during this run (a block on an earlier job): back in the queue for after the pause
        repo.setStatus(job.id, 'queued', `${siteName(job.site)} paused — prepared after the pause`);
        continue;
      }
      const page = await getPage();
      const unguardOnce = await driver.installDryRunGuard(page); // prepare never submits (auto-submit lifts it only after its gate)
      let guarded = true;
      const unguard = async () => {
        if (guarded) {
          guarded = false;
          await unguardOnce();
        }
      };
      try {
        const state = await driver.openPanel(page, job);
        markLoggedIn(job.site);
        const plan = await buildPlan(job, state.fields, { db, repo, prefs });
        plan.notes.push(`panel CVs: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'}`);
        const app = apps.savePlan(job, plan, 'needs_review');
        if (!plan.cv && job.site !== 'drushim') {
          // no fallback to another CV: the name must be set for this site
          const why = plan.notes.find((n) => /not set/.test(n)) ?? 'no CV name set for this site';
          apps.update(app.id, { status: 'failed', error: why });
          repo.setStatus(job.id, 'failed', why);
          continue;
        }
        if (plan.cv && !state.cvs.some((c) => c.name.trim() === plan.cv!.cvName.trim())) {
          apps.update(app.id, { status: 'failed', error: `CV "${plan.cv.cvName}" not found in the panel` });
          repo.setStatus(job.id, 'failed', `CV "${plan.cv.cvName}" not found`);
          continue;
        }
        if (plan.readiness === 'blocked_no') {
          const no = plan.fields.find((f) => isConfirmation(f.field) && f.status === 'resolved' && yesNo(f.value) === 'no');
          apps.update(app.id, { status: 'skipped', error: `statement is false for you: "${no?.field.label}"` });
          repo.setStatus(job.id, 'skipped_screening', `screening statement answered no: ${no?.field.label}`);
          continue;
        }
        await partialFill(driver, page, state, plan);
        const shot = await driver.screenshotPanel(page, `app${app.id}-prepare`);
        const gate = evaluateAutoSubmit(db, repo, job, plan, prefs);
        apps.update(app.id, { screenshotBefore: shot, gate });
        savePlanFile(app.id, plan);
        repo.setStatus(job.id, 'needs_review', `plan ${plan.readiness}`);
        run.stats.prepared++;
        L.info({ job: job.title, readiness: plan.readiness, fields: plan.fields.length, autoSubmit: gate.auto }, 'prepared');
        if (gate.auto) {
          await unguard(); // DRY_RUN=false is one of the gate conditions
          const sent = await autoSubmitPrepared({ driver, page, state, plan, job, appId: app.id, apps, repo, L });
          if (sent) run.stats.autoSubmitted = (run.stats.autoSubmitted ?? 0) + 1;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const closed = closeOnApplyError(apps, repo, job, null, e);
        if (closed) {
          L.info({ job: job.title }, closed.detail);
          continue;
        }
        if (e instanceof BlockedError) {
          // any block pauses the site for 48 hours; this job and the rest of that site wait (never failed for it)
          pauseSite(job.site, e.reason);
          repo.setStatus(job.id, 'queued', `${siteName(job.site)} blocked the page (${e.reason}) — paused; prepared after the pause`);
          L.error({ job: job.title, site: job.site, reason: e.reason }, 'BLOCKED — site paused for 48h, not retried');
          continue;
        }
        if (e instanceof BudgetError) {
          repo.setStatus(job.id, 'queued', e.message);
          L.info({ job: job.title }, e.message);
          continue;
        }
        repo.setStatus(job.id, 'failed', err);
        const last = apps.latestForJob(job.id);
        if (last && last.status !== 'submitted') apps.update(last.id, { status: 'failed', error: err });
        L.error({ job: job.title, err }, 'prepare failed');
        if (e instanceof ApplyError && e.code === 'not_logged_in') throw e; // stop the whole run
      } finally {
        await unguard();
      }
      await pace();
    }
  });
}

// ---------- review edits (no browser) ----------
function recompute(app: ApplicationRow, apps: Applications, repo: Repo, fields: ResolvedField[], cv = app.plan.cv) {
  const plan: ApplyPlan = { ...app.plan, cv, fields, readiness: readiness(fields) };
  apps.update(app.id, { plan });
  const job = repo.getJob(app.jobId);
  if (job && plan.readiness === 'blocked_no') {
    const no = fields.find((f) => isConfirmation(f.field) && f.status === 'resolved' && yesNo(f.value) === 'no');
    apps.update(app.id, { status: 'skipped', error: `statement is false for you: "${no?.field.label}"` });
    repo.setStatus(job.id, 'skipped_screening', `screening statement answered no: ${no?.field.label}`);
  }
  return apps.get(app.id)!;
}

export function editField(db: DB, appId: number, key: string, value: string, saveToBank: boolean): ApplicationRow {
  const apps = new Applications(db);
  const repo = new Repo(db);
  const app = apps.get(appId);
  if (!app) throw new ServiceError(404, 'application not found');
  const idx = app.plan.fields.findIndex((f) => f.field.key === key);
  if (idx < 0) throw new ServiceError(404, 'field not found');
  const f = app.plan.fields[idx]!;
  let v = value.trim();
  if (f.field.type === 'yes_no' || f.field.type === 'consent') {
    const yn = yesNo(v);
    if (!yn) throw new ServiceError(400, 'answer must be yes/no (כן/לא)');
    v = yn;
  }
  let provenance: ResolvedField['provenance'] = { source: 'user', detail: 'entered in review' };
  if (saveToBank) {
    const bank = new AnswersBank(db);
    const answer = f.field.type === 'yes_no' || f.field.type === 'consent' ? (v === 'yes' ? 'כן' : 'לא') : v;
    const e = bank.upsert({ question: f.field.label, answer, type: bankTypeFor(f.field.type), options: f.field.options ?? null, source: 'review' });
    provenance = { source: 'bank', ref: String(e.id), confidence: 1, detail: 'saved from review' };
  }
  const fields = [...app.plan.fields];
  fields[idx] = { ...f, status: 'resolved', value: v, provenance, reason: undefined };
  const updated = recompute(app, apps, repo, fields);
  if (saveToBank) refreshFromBank(db);
  return updated;
}

export function setCv(db: DB, appId: number, lang: 'he' | 'en'): ApplicationRow {
  const apps = new Applications(db);
  const app = apps.get(appId);
  if (!app) throw new ServiceError(404, 'application not found');
  const prefs = loadPrefs();
  const job = new Repo(db).getJob(app.jobId)!;
  const names = cvNamesFor(job.site, prefs);
  if (!names[lang]) throw new ServiceError(400, `no ${lang === 'he' ? 'Hebrew' : 'English'} CV name set: ${names.where}`);
  const cv = {
    lang,
    cvName: names[lang],
    hebrewRatio: Math.round(hebrewRatio(`${job.title}\n${job.descriptionText}\n${job.requirementsText}`) * 1000) / 1000,
    threshold: prefs.cv.englishMaxHebrewRatio ?? config.ENGLISH_CV_MAX_HEBREW_RATIO,
    overridden: true,
  };
  return recompute(app, apps, new Repo(db), app.plan.fields, cv);
}

/** After bank changes: resolve pending fields of open applications that now have an exact bank answer. */
export function refreshFromBank(db: DB): number {
  const apps = new Applications(db);
  const repo = new Repo(db);
  const bank = new AnswersBank(db);
  let changed = 0;
  for (const app of apps.list(['needs_review'])) {
    let touched = false;
    const fields = app.plan.fields.map((f) => {
      if (f.status !== 'pending') return f;
      const e = bank.byKey(f.normKey);
      if (!e?.answer) return f;
      const v = f.field.type === 'yes_no' || f.field.type === 'consent' ? yesNo(e.answer) : e.answer;
      if (!v) return f;
      touched = true;
      return { ...f, status: 'resolved' as const, value: v, provenance: { source: 'bank' as const, ref: String(e.id), confidence: 1, detail: 'answered in bank' }, reason: undefined };
    });
    if (touched) {
      recompute(app, apps, repo, fields);
      changed++;
    }
  }
  return changed;
}

export function rejectApplication(db: DB, appId: number, reason = 'rejected in review'): void {
  const apps = new Applications(db);
  const app = apps.get(appId);
  if (!app) throw new ServiceError(404, 'application not found');
  apps.update(appId, { status: 'rejected', error: reason, reviewed: true });
  new Repo(db).setStatus(app.jobId, 'skipped', reason);
}

// ---------- submit outcome (manual approval and auto-submit) ----------
/** why a batch (or a run) must stop: bot protection / CAPTCHA, a daily cap, or the site session */
export type SendStop = 'captcha' | 'daily_cap' | 'session';
export interface SendResult {
  appId: number;
  title: string;
  company: string;
  /** submitted | dry_run_ok | skipped | failed | needs_review | not_sent */
  status: string;
  detail: string;
  stop?: SendStop;
}

function recordSubmitResult(apps: Applications, repo: Repo, appId: number, job: StoredJob, before: string, r: SubmitResult, L: typeof log): Omit<SendResult, 'appId' | 'title' | 'company'> {
  if (r.outcome.kind === 'submitted') {
    apps.update(appId, { status: 'submitted', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, submitted: true, error: null });
    repo.setStatus(job.id, 'submitted', 'submitted');
    L.info({ job: job.title }, 'SUBMITTED');
    return { status: 'submitted', detail: r.confirmationText ?? 'sent' };
  }
  if (r.outcome.kind === 'already_applied') {
    const reason = `already_applied: the site answered "sent ${r.outcome.sentDate}"`;
    apps.update(appId, { status: 'skipped', screenshotBefore: before, screenshotAfter: r.screenshotAfter, error: reason });
    repo.setStatus(job.id, 'skipped', reason);
    return { status: 'skipped', detail: reason };
  }
  if (r.outcome.kind === 'expired') {
    const reason = `expired: ${r.outcome.message}`;
    apps.update(appId, { status: 'skipped', screenshotBefore: before, screenshotAfter: r.screenshotAfter, error: reason });
    repo.setStatus(job.id, 'skipped', reason);
    return { status: 'skipped', detail: reason };
  }
  if (r.outcome.kind === 'needs_manual') {
    // never attempted: the job goes to the assisted panel (open in your browser, copy helpers, "I applied")
    apps.update(appId, { status: 'skipped', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, error: `needs_manual: ${r.outcome.reason} — ${r.outcome.message}` });
    repo.setStatus(job.id, 'needs_manual', r.outcome.reason);
    L.warn({ job: job.title, reason: r.outcome.reason }, 'not sent: the site wants a CAPTCHA — apply by hand (assisted panel)');
    // the second CAPTCHA at send on the same site in one session pauses that site for 48 hours (any site)
    if (r.outcome.reason === 'captcha' && noteSendCaptcha(job.site) >= 2) {
      pauseSite(job.site, `the site asked for a CAPTCHA at send twice in one session (${siteName(job.site)})`, { reason: 'CAPTCHA at send twice in a session' });
      return { status: 'needs_manual', detail: `${r.outcome.message} (assisted panel) — the second CAPTCHA this session: ${siteName(job.site)} paused for 48 hours` };
    }
    return { status: 'needs_manual', detail: `${r.outcome.message} (assisted panel)` };
  }
  apps.update(appId, { status: 'failed', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, error: r.outcome.message });
  repo.setStatus(job.id, 'failed', r.outcome.message);
  return { status: 'failed', detail: r.outcome.message, stop: r.outcome.fatalForDay ? 'daily_cap' : r.outcome.needsLogin ? 'session' : undefined };
}

/**
 * Auto-submit of a prepared application whose gate passed. The kill switch, DRY_RUN and the site toggle are checked
 * again right before the final click; if any changed, the application goes to the review queue instead.
 */
/** The job page opened past the session check: the login is valid (requeues jobs that failed on "not logged in"). */
function markLoggedIn(site: string): void {
  if (getSession(site).state !== 'logged_in') setSession(site, { state: 'logged_in', checkedAt: new Date().toISOString(), detail: 'job page opened' });
}

/**
 * Last check right before the final click: no second application to the same company + title within the dedupe
 * window, on any site. The job becomes skipped_duplicate, linked to the one already sent.
 */
function sentAlready(apps: Applications, repo: Repo, appId: number, job: StoredJob): string | null {
  const s = repo.sentSameJob(job, config.DEDUPE_WINDOW_DAYS);
  if (!s) return null;
  const why = `not sent: an application to the same company and title was already sent on ${s.site} (${s.at.slice(0, 10)}) — duplicate of ${s.id}`;
  repo.markDuplicate(job.id, s.id);
  apps.update(appId, { status: 'skipped', error: why });
  return why;
}

/** Last check right before the final click: an excluded company never gets an application, even if approved earlier. */
function excludedNow(job: StoredJob): string | null {
  const match = excludedCompanyMatch(job.company, loadPrefs().filters.excludeCompanies);
  return match ? `excluded company: ${job.company} (matches "${match}")` : null;
}

async function autoSubmitPrepared(o: {
  driver: ApplyDriver;
  page: Page;
  state: PanelState;
  plan: ApplyPlan;
  job: StoredJob;
  appId: number;
  apps: Applications;
  repo: Repo;
  L: typeof log;
}): Promise<boolean> {
  const { driver, page, state, plan, job, appId, apps, repo, L } = o;
  apps.update(appId, { status: 'approved', dryRun: false });
  await driver.fillPanel(page, state, plan);
  const before = await driver.screenshotPanel(page, `app${appId}-before-submit`);
  await pace(1500, 3000);
  if (config.DRY_RUN || !autoSubmitOn(job.site)) {
    apps.update(appId, { status: 'needs_review', screenshotBefore: before, error: 'auto-submit was paused before sending — review it' });
    repo.setStatus(job.id, 'needs_review', 'auto-submit paused before sending');
    L.warn({ job: job.title }, 'auto-submit paused before the final click — left for review');
    return false;
  }
  const excluded = excludedNow(job);
  if (excluded) {
    repo.closeForExcludedCompany(job.id, excluded);
    L.warn({ job: job.title }, `not sent: ${excluded}`);
    return false;
  }
  const dup = sentAlready(apps, repo, appId, job);
  if (dup) {
    L.warn({ job: job.title }, dup);
    return false;
  }
  L.info({ job: job.title }, 'AUTO-SUBMIT: every gate condition passed');
  const r = await driver.submitPanel(page, job, `app${appId}`, plan.cv?.cvName);
  const res = recordSubmitResult(apps, repo, appId, job, before, r, L);
  if (res.stop) throw new Error(res.detail); // daily cap / session: stop the run
  return res.status === 'submitted';
}

// ---------- never twice, never stuck ----------
/** This job already has a sent application (or you applied by hand): the reason, or null. */
export function alreadySent(db: DB, jobId: string, exceptAppId?: number): string | null {
  const a = db.prepare(`SELECT id, submitted_at FROM applications WHERE job_id = ? AND status = 'submitted' AND id != ? ORDER BY id LIMIT 1`).get(jobId, exceptAppId ?? -1) as { id: number; submitted_at: string | null } | undefined;
  if (a) return `already sent (application #${a.id}${a.submitted_at ? `, ${a.submitted_at.slice(0, 10)}` : ''})`;
  const j = db.prepare(`SELECT status, applied_manually_at FROM jobs WHERE id = ?`).get(jobId) as { status: string; applied_manually_at: string | null } | undefined;
  if (j?.status === 'submitted_manual') return `already applied by hand${j.applied_manually_at ? ` (${j.applied_manually_at.slice(0, 10)})` : ''}`;
  return null;
}

/** A send that ended before reaching the final click: the application goes back to the review queue. */
function releaseIfStuck(db: DB, appId: number, why: string): void {
  const apps = new Applications(db);
  // approved: stopped before the final step; needs_review: the run failed before even reaching it — either way say why
  if (!['approved', 'needs_review'].includes(apps.get(appId)?.status ?? '')) return;
  apps.update(appId, { status: 'needs_review', error: `not sent — the run stopped before sending: ${why.split('\n')[0]}` });
}

/**
 * At startup (no run can be active then): applications left "approved" by a run that never finished. Without any
 * trace of the final step (a before-submit screenshot, a saved send request or response after the approval) they go
 * back to needs_review. With such a trace the send may have gone out: they are blocked, never sent again
 * automatically — check on the site, then mark it in History or reject it.
 */
export function recoverStuckApprovals(db: DB): Array<{ id: number; to: 'needs_review' | 'blocked'; why: string }> {
  const apps = new Applications(db);
  const out: Array<{ id: number; to: 'needs_review' | 'blocked'; why: string }> = [];
  const files = fs.existsSync(config.paths.screenshots) ? fs.readdirSync(config.paths.screenshots) : [];
  for (const a of apps.list(['approved'])) {
    const since = Date.parse(a.reviewedAt ?? a.updatedAt);
    const trace = files.find(
      (f) => (f.startsWith(`app${a.id}-before-submit-`) || f.startsWith(`app${a.id}-after-`) || f === `app${a.id}-request.txt` || f.startsWith(`app${a.id}-response.`)) &&
        fs.statSync(path.join(config.paths.screenshots, f)).mtimeMs >= since - 1000,
    );
    if (trace) {
      const why = `the send may have gone out (${trace}) but no answer was recorded — check on the site, then mark it in History or reject it`;
      apps.update(a.id, { status: 'blocked', error: why });
      out.push({ id: a.id, to: 'blocked', why });
    } else {
      const lastRun = db.prepare(`SELECT reason FROM runs WHERE kind IN ('submit','dry_run','submit_batch','dry_run_batch') AND status != 'done' AND started_at >= ? ORDER BY id LIMIT 1`).get(new Date(since - 5000).toISOString()) as { reason: string | null } | undefined;
      const why = `approved on ${(a.reviewedAt ?? a.updatedAt).slice(0, 16).replace('T', ' ')} but never sent${lastRun?.reason ? ` (${lastRun.reason.split('\n')[0]})` : ''} — back for review`;
      apps.update(a.id, { status: 'needs_review', error: why });
      out.push({ id: a.id, to: 'needs_review', why });
    }
  }
  return out;
}

/** Why Approve is not possible for this application right now (from its own state; null = it can be approved). */
export function approveBlock(db: DB, app: ApplicationRow): string | null {
  const sent = alreadySent(db, app.jobId, app.status === 'submitted' ? app.id : undefined);
  if (app.status === 'submitted') return 'already sent';
  if (sent) return sent;
  if (app.status === 'approved') return 'sending now';
  if (app.status === 'rejected') return /^duplicate of /.test(app.error ?? '') ? `duplicate: ${app.error}` : `rejected${app.error ? `: ${app.error}` : ''}`;
  if (app.status === 'skipped') return `skipped${app.error ? `: ${app.error}` : ''}`;
  if (app.status === 'blocked') return `blocked: ${app.error ?? 'check on the site'}`;
  if (!(OPEN as readonly string[]).includes(app.status)) return `application is ${app.status}`;
  const pending = app.plan.fields.filter((f) => f.status === 'pending').length;
  if (pending) return `answer ${pending} pending question${pending > 1 ? 's' : ''} first`;
  if (app.plan.readiness === 'blocked_no') return 'a required statement is false for you';
  if (!app.plan.cv) return 'no CV chosen (Preferences)';
  const job = new Repo(db).getJob(app.jobId);
  if (job && !driverFor(job.site)) return `no automated apply flow for ${job.site}`;
  if (job && isPaused(job.site)) return pausedText(job.site, siteName(job.site));
  return null;
}

// ---------- approve ----------
/** The checks an application must pass to be approved (one by one or in a batch). */
function approvable(db: DB, appId: number): { app: ApplicationRow; job: StoredJob } {
  const apps = new Applications(db);
  const app = apps.get(appId);
  if (!app) throw new ServiceError(404, 'application not found');
  if (!(OPEN as readonly string[]).includes(app.status)) throw new ServiceError(409, `application is ${app.status}`);
  if (app.plan.fields.some((f) => f.status === 'pending')) throw new ServiceError(409, 'answer all pending questions first');
  if (app.plan.readiness === 'blocked_no') throw new ServiceError(409, 'a required statement is false for you');
  const job = new Repo(db).getJob(app.jobId);
  if (!job) throw new ServiceError(404, 'job not found');
  if (!app.plan.cv) throw new ServiceError(409, `no CV chosen (set ${cvNamesFor(job.site, loadPrefs()).where})`);
  if (!driverFor(job.site)) throw new ServiceError(400, `no automated apply flow for ${job.site}`);
  const sent = alreadySent(db, job.id);
  if (sent) throw new ServiceError(409, sent);
  return { app, job };
}

const dailyLimitReached = (repo: Repo, site: string) => repo.submittedToday(site) >= effectiveLimits(loadPrefs()).dailyApplyLimit;

/**
 * Sends one approved application (or, in DRY_RUN, fills it and stops before the final click). Never throws: the
 * result says what happened and whether a batch must stop (bot protection, a daily cap, the session).
 */
async function sendApproved(db: DB, appId: number, job: StoredJob, dryRun: boolean, L: typeof log, applied: Map<string, string | null> | null): Promise<SendResult> {
  const apps = new Applications(db);
  const repo = new Repo(db);
  const app = apps.get(appId)!;
  const done = (status: string, detail: string, stop?: SendStop): SendResult => ({ appId, title: job.title, company: job.company, status, detail, stop });
  const paused = pausedText(job.site, siteName(job.site));
  if (paused) {
    apps.update(appId, { status: 'needs_review', error: `not sent: ${paused}` });
    return done('not_sent', paused);
  }
  if (!dryRun && dailyLimitReached(repo, job.site)) {
    apps.update(appId, { status: 'needs_review', error: 'not sent: the daily limit was reached' });
    return done('not_sent', `daily apply limit reached (${effectiveLimits(loadPrefs()).dailyApplyLimit})`, 'daily_cap');
  }
  apps.update(appId, { status: 'approved', reviewed: true, dryRun });
  // applied on the site in the meantime (by hand, or another device)? → skipped, never failed
  if (applied?.has(job.externalId)) {
    const when = applied.get(job.externalId);
    const reason = `already_applied: on ${job.site}${when ? ` (sent ${when.slice(0, 10)})` : ''}`;
    apps.update(appId, { status: 'skipped', error: reason });
    repo.setStatus(job.id, 'skipped', reason);
    L.info({ job: job.title }, reason);
    return done('skipped', reason);
  }
  const driver = driverFor(job.site)!;
  const page = await getPage();
  const unguard = dryRun ? await driver.installDryRunGuard(page) : async () => undefined;
  try {
    const early = excludedNow(job);
    if (early) {
      repo.closeForExcludedCompany(job.id, early);
      L.warn({ job: job.title }, `not sent: ${early}`);
      return done('skipped', early);
    }
    const state = await driver.openPanel(page, job);
    markLoggedIn(job.site);
    // the live form must match what was reviewed
    const planned = new Set(app.plan.fields.map((f) => `${f.field.key}|${f.field.label}`));
    const live = state.fields.filter((f) => f.type !== 'textarea').map((f) => `${f.key}|${f.label}`);
    const changed = live.filter((k) => !planned.has(k));
    if (changed.length) {
      const plan = await buildPlan(job, state.fields, { db, repo, prefs: loadPrefs() }, app.plan.cv);
      apps.savePlan(job, plan, 'needs_review');
      repo.setStatus(job.id, 'needs_review', 'the form changed since review');
      L.warn({ changed }, 'form changed since review — back to the review queue');
      return done('needs_review', 'the form changed since review — back to the review queue');
    }
    await driver.fillPanel(page, state, app.plan);
    const before = await driver.screenshotPanel(page, `app${appId}-${dryRun ? 'dryrun' : 'before-submit'}`);
    savePlanFile(appId, app.plan);
    if (dryRun) {
      apps.update(appId, { status: 'dry_run_ok', screenshotBefore: before, error: null });
      repo.setStatus(job.id, 'dry_run_ok', 'DRY_RUN: stopped before the final click');
      L.info({ job: job.title }, 'DRY_RUN ok — stopped before submit');
      return done('dry_run_ok', 'DRY_RUN: filled, stopped before the final click');
    }
    await pace(1500, 3000);
    const excluded = excludedNow(job); // preferences may have changed while the panel was filled
    if (excluded) {
      repo.closeForExcludedCompany(job.id, excluded);
      L.warn({ job: job.title }, `not sent: ${excluded}`);
      return done('skipped', excluded);
    }
    const twice = alreadySent(db, job.id, appId);
    if (twice) {
      apps.update(appId, { status: 'skipped', error: `not sent: ${twice}` });
      L.warn({ job: job.title }, twice);
      return done('skipped', twice);
    }
    const dup = sentAlready(apps, repo, appId, job); // e.g. the same job sent from another site earlier in this batch
    if (dup) {
      L.warn({ job: job.title }, dup);
      return done('skipped', dup);
    }
    const r = await driver.submitPanel(page, job, `app${appId}`, app.plan.cv?.cvName);
    const res = recordSubmitResult(apps, repo, appId, job, before, r, L);
    return done(res.status, res.detail, res.stop);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const closed = closeOnApplyError(apps, repo, job, appId, e);
    if (closed) return done(closed.status, closed.detail);
    if (e instanceof BlockedError) {
      // the page was refused before anything was sent: back to review, and the site pauses for 48 hours
      pauseSite(job.site, e.reason);
      apps.update(appId, { status: 'needs_review', error: `not sent: ${siteName(job.site)} blocked the page (${e.reason}) — site paused` });
      repo.setStatus(job.id, 'needs_review', `${siteName(job.site)} paused after a block`);
      L.error({ job: job.title, reason: e.reason }, 'BLOCKED — site paused for 48h, not sent');
      return done('not_sent', `${siteName(job.site)} blocked the page — paused for 48 hours`, 'captcha');
    }
    if (e instanceof BudgetError) {
      apps.update(appId, { status: 'needs_review', error: `not sent: ${e.message}` });
      return done('not_sent', e.message);
    }
    if (apps.get(appId)?.status === 'approved') {
      apps.update(appId, { status: 'failed', error: err });
      repo.setStatus(job.id, 'failed', err);
    }
    const stop: SendStop | undefined =
      e instanceof BlockedError ? 'captcha' : e instanceof ApplyError && e.code === 'not_logged_in' ? 'session' : e instanceof ApplyError && e.code === 'daily_limit' ? 'daily_cap' : undefined;
    L.error({ job: job.title, err }, 'send failed');
    return done('failed', err, stop);
  } finally {
    await unguard();
  }
}

export function approveApplication(db: DB, appId: number): { runId: number; dryRun: boolean } {
  const { job } = approvable(db, appId);
  const repo = new Repo(db);
  const dryRun = config.DRY_RUN;
  if (!dryRun && dailyLimitReached(repo, job.site)) throw new ServiceError(429, `daily apply limit reached (${effectiveLimits(loadPrefs()).dailyApplyLimit})`);
  // "approved" is set by sendApproved when the send really starts: a run that cannot start (another run is active) or
  // fails before reaching the job (browser profile in use, login) leaves the application in review, never stuck
  const runId = startTask(db, job.site, dryRun ? 'dry_run' : 'submit', async (run, _repo, L) => {
    run.stage = `${dryRun ? 'dry run' : 'SUBMIT'}: ${job.title}`;
    try {
      const applied = await driverFor(job.site)!.fetchAppliedJobs(await getPage()).catch(() => null);
      const r = await sendApproved(db, appId, job, dryRun, L, applied);
      if (r.stop) throw new Error(r.detail); // bot protection / daily cap / session: the run failed
    } catch (e) {
      releaseIfStuck(db, appId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  });
  return { runId, dryRun };
}

// ---------- batch approval ----------
/**
 * Why an application cannot be approved in a batch (null = it can): drafts, pending answers and flagged claims need
 * your individual review, and so does anything not ready.
 */
export function batchBlock(app: ApplicationRow): string | null {
  if (!(OPEN as readonly string[]).includes(app.status)) return `application is ${app.status}`;
  if (!app.plan.cv) return 'no CV chosen';
  const f = app.plan.fields.find((x) => x.status === 'pending' || x.status === 'draft' || (x.provenance.flaggedClaims?.length ?? 0) > 0);
  if (f) return `"${f.field.label}": ${f.status === 'pending' ? 'answer pending' : f.status === 'draft' ? 'draft written by the model' : 'flagged claims'} — review it on its own`;
  if (app.plan.readiness !== 'ready') return `plan is ${app.plan.readiness}`;
  return null;
}

export interface BatchProgress {
  runId: number;
  dryRun: boolean;
  startedAt: string;
  total: number;
  done: number;
  current: string | null;
  results: SendResult[];
  stoppedReason: string | null;
  finished: boolean;
  /** sends the site answered with a CAPTCHA (never attempted; those jobs are in the assisted panel) */
  captchas: number;
}
let batch: BatchProgress | null = null;
export const batchProgress = () => batch;

const STOP_TEXT: Record<SendStop, string> = {
  captcha: 'the site showed a CAPTCHA / bot protection — stopped (never bypassed); open the site yourself and try later',
  daily_cap: 'a daily cap was reached — stopped; the rest stay in the review queue',
  session: 'the site session is not logged in — stopped; log in again, the rest stay in the review queue',
};

/** Approves the selected applications and sends them one after another (normal pacing), stopping on a stop condition. */
export function approveBatch(db: DB, appIds: number[]): { runId: number; dryRun: boolean; accepted: number; refused: Array<{ appId: number; reason: string }> } {
  const apps = new Applications(db);
  const repo = new Repo(db);
  const prefs = loadPrefs();
  const refused: Array<{ appId: number; reason: string }> = [];
  const accepted: Array<{ app: ApplicationRow; job: StoredJob; rank: number }> = [];
  for (const id of [...new Set(appIds)]) {
    const app = apps.get(id);
    const block = app ? batchBlock(app) : 'not found';
    const job = app ? repo.getJob(app.jobId) : null;
    const sent = job ? alreadySent(db, job.id) : null;
    const paused = job ? pausedText(job.site, siteName(job.site)) : null;
    if (block || sent || paused || !app || !job || !driverFor(job.site)) refused.push({ appId: id, reason: block ?? sent ?? paused ?? (job ? `no automated apply flow for ${job.site}` : 'job not found') });
    else accepted.push({ app, job, rank: rankStoredJob(job, repo.getScore(job.id), prefs).rank ?? -Infinity });
  }
  if (!accepted.length) throw new ServiceError(409, `nothing to approve: ${refused.map((r) => `#${r.appId} ${r.reason}`).join('; ')}`);
  accepted.sort((a, b) => b.rank - a.rank); // the best first, in case a cap stops the batch
  const dryRun = config.DRY_RUN;
  const runId = startTask(db, taskSite(accepted.map((a) => a.job.site)), dryRun ? 'dry_run_batch' : 'submit_batch', async (run, _repo, L) => {
    const page = await getPage();
    // each site's applied list, read once when the batch reaches that site
    const appliedBySite = new Map<string, Map<string, string | null> | null>();
    const appliedFor = async (site: string) => {
      if (!appliedBySite.has(site)) appliedBySite.set(site, await driverFor(site)!.fetchAppliedJobs(page).catch(() => null));
      return appliedBySite.get(site)!;
    };
    // a CAPTCHA is never attempted; the second one on a site pauses it, so the rest of that site waits (left in review)
    for (const [i, { app, job }] of accepted.entries()) {
      if (run.controller.signal.aborted) {
        batch!.stoppedReason = 'stopped by you';
        break;
      }
      batch!.current = `${i + 1}/${accepted.length}: ${job.title} — ${job.company}`;
      run.stage = `${dryRun ? 'dry run' : 'SUBMIT'} ${batch!.current}`;
      const fresh = apps.get(app.id);
      const still = fresh ? batchBlock(fresh) : 'gone';
      const r: SendResult = still
        ? { appId: app.id, title: job.title, company: job.company, status: 'not_sent', detail: `changed since you selected it: ${still}` }
        : await sendApproved(db, app.id, job, dryRun, L, await appliedFor(job.site));
      batch!.results.push(r);
      batch!.done++;
      run.stats.sent = (run.stats.sent ?? 0) + (r.status === 'submitted' ? 1 : 0);
      if (r.status === 'needs_manual') {
        batch!.captchas++;
        run.stats.captchas = (run.stats.captchas ?? 0) + 1;
      }
      if (r.stop) {
        batch!.stoppedReason = STOP_TEXT[r.stop];
        for (const rest of accepted.slice(i + 1)) batch!.results.push({ appId: rest.app.id, title: rest.job.title, company: rest.job.company, status: 'not_sent', detail: 'not sent: the batch stopped' });
        L.warn({ stop: r.stop }, `batch stopped: ${STOP_TEXT[r.stop]}`);
        break;
      }
      // after a CAPTCHA, a much longer pause before the next send
      if (i < accepted.length - 1) await (r.status === 'needs_manual' ? pace(45_000, 90_000) : pace());
    }
    batch!.current = null;
    batch!.finished = true;
  });
  batch = { runId, dryRun, startedAt: new Date().toISOString(), total: accepted.length, done: 0, current: null, results: [], stoppedReason: null, finished: false, captchas: 0 };
  return { runId, dryRun, accepted: accepted.length, refused };
}
