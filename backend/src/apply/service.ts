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
import { rankStoredJob } from '../core/rank.js';
import { getPage, pace } from '../browser/session.js';
import { startTask } from '../pipeline/runner.js';
import { ApplyError, fillPanel, installDryRunGuard, openPanel, screenshot, submitPanel, type PanelState } from '../sites/drushim/apply.js';
import { AnswersBank, bankTypeFor, yesNo } from './bank.js';
import { hebrewRatio } from './cv.js';
import { Applications, buildPlan, readiness, type ApplicationRow } from './plan.js';
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
  for (const j of jobs) repo.setStatus(j.id, 'queued', 'preparing application');

  return startTask(db, 'drushim', 'prepare', async (run, _repo, L) => {
    const prefs = loadPrefs();
    new AnswersBank(db).seed(prefs);
    run.stats.prepared = 0;
    for (const job of jobs) {
      if (run.controller.signal.aborted) return;
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
      const unguard = await installDryRunGuard(page); // prepare never submits
      try {
        const state = await openPanel(page, job.url);
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
        const shot = await screenshot(page, `app${app.id}-prepare`);
        apps.update(app.id, { screenshotBefore: shot });
        savePlanFile(app.id, plan);
        repo.setStatus(job.id, 'needs_review', `plan ${plan.readiness}`);
        run.stats.prepared++;
        L.info({ job: job.title, readiness: plan.readiness, fields: plan.fields.length }, 'prepared');
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (e instanceof ApplyError && e.code === 'already_applied') {
          repo.setStatus(job.id, 'skipped', `already applied: ${err}`);
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
    const unguard = dryRun ? await installDryRunGuard(page) : async () => undefined;
    try {
      const state = await openPanel(page, job.url);
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
      const before = await screenshot(page, `app${appId}-${dryRun ? 'dryrun' : 'before-submit'}`);
      savePlanFile(appId, app.plan);
      if (dryRun) {
        apps.update(appId, { status: 'dry_run_ok', screenshotBefore: before, error: null });
        repo.setStatus(job.id, 'dry_run_ok', 'DRY_RUN: stopped before the final click');
        L.info({ job: job.title }, 'DRY_RUN ok — stopped before submit');
        return;
      }
      await pace(1500, 3000);
      const r = await submitPanel(page, Number(job.externalId), `app${appId}`);
      if (r.outcome.kind === 'submitted') {
        apps.update(appId, { status: 'submitted', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, submitted: true, error: null });
        repo.setStatus(job.id, 'submitted', 'submitted');
        L.info({ job: job.title }, 'SUBMITTED');
      } else if (r.outcome.kind === 'already_applied') {
        apps.update(appId, { status: 'skipped', screenshotBefore: before, screenshotAfter: r.screenshotAfter, error: `already applied on ${r.outcome.sentDate}` });
        repo.setStatus(job.id, 'skipped', `already applied on ${r.outcome.sentDate}`);
      } else {
        apps.update(appId, { status: 'failed', screenshotBefore: before, screenshotAfter: r.screenshotAfter, confirmationText: r.confirmationText, error: r.outcome.message });
        repo.setStatus(job.id, 'failed', r.outcome.message);
        if (r.outcome.fatalForDay || r.outcome.needsLogin) throw new Error(r.outcome.message);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const cur = apps.get(appId);
      if (cur?.status === 'approved') {
        if (e instanceof ApplyError && e.code === 'already_applied') {
          apps.update(appId, { status: 'skipped', error: err });
          repo.setStatus(job.id, 'skipped', err);
        } else {
          apps.update(appId, { status: 'failed', error: err });
          repo.setStatus(job.id, 'failed', err);
        }
      }
      throw e;
    } finally {
      await unguard();
    }
  });
  return { runId, dryRun };
}
