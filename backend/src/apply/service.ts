/**
 * Apply orchestration (Drushim, Phase 2):
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
import { getPage, pace } from '../browser/session.js';
import type { Page } from 'playwright';
import type { log } from '../log.js';
import { startTask } from '../pipeline/runner.js';
import { ApplyError, fillPanel, installDryRunGuard, openPanel, screenshot, submitPanel, type PanelState, fetchAppliedJobs, screenshotPanel, type SubmitResult } from '../sites/drushim/apply.js';
import { AnswersBank, bankTypeFor, yesNo } from './bank.js';
import { hebrewRatio } from './cv.js';
import { Applications, buildPlan, readiness, type ApplicationRow } from './plan.js';
import { autoSubmitOn, evaluateAutoSubmit } from './auto-submit.js';
import { getSession, setSession } from '../browser/site-session.js';
import { excludedCompanyMatch } from '../core/prefilter.js';
import type { ApplyPlan, ResolvedField } from './types.js';

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

/** Tick confirmations that are resolved "yes" and select the CV — used for the prepare screenshot (never submits). */
async function partialFill(page: Parameters<typeof fillPanel>[0], state: PanelState, plan: ApplyPlan) {
  const confirmable: ApplyPlan = {
    ...plan,
    fields: plan.fields,
  };
  const subset: PanelState = {
    ...state,
    fields: state.fields.filter((f) => {
      const p = plan.fields.find((x) => x.field.key === f.key);
      return (f.type !== 'yes_no' && f.type !== 'consent') || (p?.status === 'resolved' && yesNo(p.value) === 'yes');
    }),
  };
  await fillPanel(page, subset, confirmable);
}

// ---------- prepare ----------
export function prepareJobs(db: DB, jobIds: string[]): number {
  const repo = new Repo(db);
  const apps = new Applications(db);
  const prefsNow = loadPrefs();
  // highest rank first, so the daily limit is spent on the best jobs
  const jobs = jobIds
    .map((id) => repo.getJob(id))
    .filter((j): j is StoredJob => !!j)
    .map((j) => ({ j, r: rankStoredJob(j, repo.getScore(j.id), prefsNow).rank ?? -Infinity }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.j);
  if (jobs.length === 0) throw new ServiceError(404, 'no such jobs');
  // LinkedIn is assisted-only: a LinkedIn job reaches the review queue only as an external link the user pasted
  if (jobs.some((j) => j.site === 'linkedin' && !(j.applyType === 'external' && j.applyTarget))) {
    throw new ServiceError(400, 'LinkedIn jobs are applied to by hand: use the LinkedIn screen (Open in my browser)');
  }
  for (const j of jobs) repo.setStatus(j.id, 'queued', 'preparing application');

  return startTask(db, 'drushim', 'prepare', async (run, _repo, L) => {
    const prefs = loadPrefs();
    new AnswersBank(db).seed(prefs, candidateGender());
    run.stats.prepared = 0;
    // the site's own list of jobs this account applied to, read once per run
    let applied: Map<string, string | null> | null = null;
    if (jobs.some((j) => j.site === 'drushim' && j.applyType !== 'external' && j.applyType !== 'email')) {
      applied = await fetchAppliedJobs(await getPage()).catch((e: unknown) => {
        L.warn({ err: e instanceof Error ? e.message : String(e) }, 'could not read the already-applied list; each job page is still checked');
        return null;
      });
      if (applied) run.stats.alreadyApplied = repo.markAlreadyApplied('drushim', applied);
    }
    for (const job of jobs) {
      if (run.controller.signal.aborted) return;
      if (applied?.has(job.externalId)) continue; // skipped already_applied above
      run.stage = `preparing ${job.title}`;
      if (job.applyType === 'external' || job.applyType === 'email') {
        const plan: ApplyPlan = { jobId: job.id, site: job.site, createdAt: new Date().toISOString(), cv: null, fields: [], readiness: 'needs_answers', notes: [`${job.applyType} apply → ${job.applyTarget} (handled manually in this phase)`] };
        apps.savePlan(job, plan, 'needs_review');
        repo.setStatus(job.id, 'needs_review', `${job.applyType} apply`);
        continue;
      }
      if (job.site !== 'drushim') {
        repo.setStatus(job.id, 'failed', `no apply flow for ${job.site} yet`);
        continue;
      }
      const page = await getPage();
      const unguardOnce = await installDryRunGuard(page); // prepare never submits (auto-submit lifts it only after its gate)
      let guarded = true;
      const unguard = async () => {
        if (guarded) {
          guarded = false;
          await unguardOnce();
        }
      };
      try {
        const state = await openPanel(page, job.url);
        markLoggedIn();
        const plan = await buildPlan(job, state.fields, { db, repo, prefs });
        plan.notes.push(`panel CVs: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'}`);
        const app = apps.savePlan(job, plan, 'needs_review');
        if (plan.cv && !state.cvs.some((c) => c.name.trim() === plan.cv!.cvName.trim())) {
          apps.update(app.id, { status: 'failed', error: `CV "${plan.cv.cvName}" not found in the panel` });
          repo.setStatus(job.id, 'failed', `CV "${plan.cv.cvName}" not found`);
          continue;
        }
        if (plan.readiness === 'blocked_no') {
          const no = plan.fields.find((f) => f.status === 'resolved' && yesNo(f.value) === 'no');
          apps.update(app.id, { status: 'skipped', error: `statement is false for you: "${no?.field.label}"` });
          repo.setStatus(job.id, 'skipped_screening', `screening statement answered no: ${no?.field.label}`);
          continue;
        }
        await partialFill(page, state, plan);
        const shot = await screenshotPanel(page, `app${app.id}-prepare`);
        const gate = evaluateAutoSubmit(db, repo, job, plan, prefs);
        apps.update(app.id, { screenshotBefore: shot, gate });
        savePlanFile(app.id, plan);
        repo.setStatus(job.id, 'needs_review', `plan ${plan.readiness}`);
        run.stats.prepared++;
        L.info({ job: job.title, readiness: plan.readiness, fields: plan.fields.length, autoSubmit: gate.auto }, 'prepared');
        if (gate.auto) {
          await unguard(); // DRY_RUN=false is one of the gate conditions
          const sent = await autoSubmitPrepared({ page, state, plan, job, appId: app.id, apps, repo, L });
          if (sent) run.stats.autoSubmitted = (run.stats.autoSubmitted ?? 0) + 1;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (e instanceof ApplyError && e.code === 'already_applied') {
          repo.setStatus(job.id, 'skipped', `already_applied: ${err}`);
          const last = apps.latestForJob(job.id);
          if (last && last.status !== 'submitted') apps.update(last.id, { status: 'skipped', error: `already_applied: ${err}` });
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
    const no = fields.find((f) => f.status === 'resolved' && yesNo(f.value) === 'no');
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
  const cv = {
    lang,
    cvName: prefs.cv[lang],
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
function recordSubmitResult(apps: Applications, repo: Repo, appId: number, job: StoredJob, before: string, r: SubmitResult, L: typeof log): boolean {
  if (r.outcome.kind === 'submitted') {
    apps.update(appId, { status: 'submitted', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, submitted: true, error: null });
    repo.setStatus(job.id, 'submitted', 'submitted');
    L.info({ job: job.title }, 'SUBMITTED');
    return true;
  }
  if (r.outcome.kind === 'already_applied') {
    const reason = `already_applied: the site answered "sent ${r.outcome.sentDate}"`;
    apps.update(appId, { status: 'skipped', screenshotBefore: before, screenshotAfter: r.screenshotAfter, error: reason });
    repo.setStatus(job.id, 'skipped', reason);
    return false;
  }
  apps.update(appId, { status: 'failed', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, error: r.outcome.message });
  repo.setStatus(job.id, 'failed', r.outcome.message);
  if (r.outcome.fatalForDay || r.outcome.needsLogin) throw new Error(r.outcome.message);
  return false;
}

/**
 * Auto-submit of a prepared application whose gate passed. The kill switch, DRY_RUN and the site toggle are checked
 * again right before the final click; if any changed, the application goes to the review queue instead.
 */
/** The job page opened past the session check: the login is valid (requeues jobs that failed on "not logged in"). */
function markLoggedIn(): void {
  if (getSession('drushim').state !== 'logged_in') setSession('drushim', { state: 'logged_in', checkedAt: new Date().toISOString(), detail: 'job page opened' });
}

/** Last check right before the final click: an excluded company never gets an application, even if approved earlier. */
function excludedNow(job: StoredJob): string | null {
  const match = excludedCompanyMatch(job.company, loadPrefs().filters.excludeCompanies);
  return match ? `excluded company: ${job.company} (matches "${match}")` : null;
}

async function autoSubmitPrepared(o: {
  page: Page;
  state: PanelState;
  plan: ApplyPlan;
  job: StoredJob;
  appId: number;
  apps: Applications;
  repo: Repo;
  L: typeof log;
}): Promise<boolean> {
  const { page, state, plan, job, appId, apps, repo, L } = o;
  apps.update(appId, { status: 'approved', dryRun: false });
  await fillPanel(page, state, plan);
  const before = await screenshotPanel(page, `app${appId}-before-submit`);
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
  L.info({ job: job.title }, 'AUTO-SUBMIT: every gate condition passed');
  const r = await submitPanel(page, Number(job.externalId), `app${appId}`);
  return recordSubmitResult(apps, repo, appId, job, before, r, L);
}

// ---------- approve ----------
export function approveApplication(db: DB, appId: number): { runId: number; dryRun: boolean } {
  const apps = new Applications(db);
  const repo = new Repo(db);
  const app = apps.get(appId);
  if (!app) throw new ServiceError(404, 'application not found');
  if (!(OPEN as readonly string[]).includes(app.status)) throw new ServiceError(409, `application is ${app.status}`);
  if (app.plan.fields.some((f) => f.status === 'pending')) throw new ServiceError(409, 'answer all pending questions first');
  if (app.plan.readiness === 'blocked_no') throw new ServiceError(409, 'a required statement is false for you');
  if (!app.plan.cv) throw new ServiceError(409, 'no CV chosen (set cv.he / cv.en in preferences.yaml)');
  const job = repo.getJob(app.jobId);
  if (!job) throw new ServiceError(404, 'job not found');
  const dryRun = config.DRY_RUN;
  if (!dryRun) {
    const limits = effectiveLimits(loadPrefs());
    if (repo.submittedToday() >= limits.dailyApplyLimit) throw new ServiceError(429, `daily apply limit reached (${limits.dailyApplyLimit})`);
  }
  apps.update(appId, { status: 'approved', reviewed: true, dryRun });

  const runId = startTask(db, 'drushim', dryRun ? 'dry_run' : 'submit', async (run, _repo, L) => {
    run.stage = `${dryRun ? 'dry run' : 'SUBMIT'}: ${job.title}`;
    const page = await getPage();
    // applied on the site in the meantime (by hand, or another device)? → skipped, never failed
    const applied = await fetchAppliedJobs(page).catch(() => null);
    if (applied?.has(job.externalId)) {
      const when = applied.get(job.externalId);
      const reason = `already_applied: on drushim${when ? ` (sent ${when.slice(0, 10)})` : ''}`;
      apps.update(appId, { status: 'skipped', error: reason });
      repo.setStatus(job.id, 'skipped', reason);
      L.info({ job: job.title }, reason);
      return;
    }
    const unguard = dryRun ? await installDryRunGuard(page) : async () => undefined;
    try {
      const early = excludedNow(job);
      if (early) {
        repo.closeForExcludedCompany(job.id, early);
        L.warn({ job: job.title }, `not sent: ${early}`);
        return;
      }
      const state = await openPanel(page, job.url);
      markLoggedIn();
      // the live form must match what was reviewed
      const planned = new Set(app.plan.fields.map((f) => `${f.field.key}|${f.field.label}`));
      const live = state.fields.filter((f) => f.type !== 'textarea').map((f) => `${f.key}|${f.label}`);
      const changed = live.filter((k) => !planned.has(k));
      if (changed.length) {
        const plan = await buildPlan(job, state.fields, { db, repo, prefs: loadPrefs() }, app.plan.cv);
        apps.savePlan(job, plan, 'needs_review');
        repo.setStatus(job.id, 'needs_review', 'the form changed since review');
        L.warn({ changed }, 'form changed since review — back to the review queue');
        return;
      }
      await fillPanel(page, state, app.plan);
      const before = await screenshotPanel(page, `app${appId}-${dryRun ? 'dryrun' : 'before-submit'}`);
      savePlanFile(appId, app.plan);
      if (dryRun) {
        apps.update(appId, { status: 'dry_run_ok', screenshotBefore: before, error: null });
        repo.setStatus(job.id, 'dry_run_ok', 'DRY_RUN: stopped before the final click');
        L.info({ job: job.title }, 'DRY_RUN ok — stopped before submit');
        return;
      }
      await pace(1500, 3000);
      const excluded = excludedNow(job); // preferences may have changed while the panel was filled
      if (excluded) {
        repo.closeForExcludedCompany(job.id, excluded);
        L.warn({ job: job.title }, `not sent: ${excluded}`);
        return;
      }
      const r = await submitPanel(page, Number(job.externalId), `app${appId}`);
      recordSubmitResult(apps, repo, appId, job, before, r, L);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const cur = apps.get(appId);
      if (cur?.status === 'approved') {
        if (e instanceof ApplyError && e.code === 'already_applied') {
          apps.update(appId, { status: 'skipped', error: `already_applied: ${err}` });
          repo.setStatus(job.id, 'skipped', `already_applied: ${err}`);
          return; // not a failure of the run
        }
        apps.update(appId, { status: 'failed', error: err });
        repo.setStatus(job.id, 'failed', err);
      }
      if (e instanceof ApplyError && e.code === 'already_applied') return;
      throw e;
    } finally {
      await unguard();
    }
  });
  return { runId, dryRun };
}
