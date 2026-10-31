/**
 * One full hunt — "Run & send" in the dashboard, npm start -- --hunt [--send], the in-app schedule or Windows Task
 * Scheduler: job-alert emails (LinkedIn / Indeed, only when that optional feature is on); discover on every enabled site → score;
 * then prepare plans for the best new Drushim jobs within today's limit and send the ones that pass the auto-submit
 * gate (only with DRY_RUN off and auto-submit on for the site; otherwise it stops after prepare).
 * Live progress (step, counts, current job) is kept for the dashboard while it runs.
 * If the Drushim login has expired, the hunt stays discovery-only and its summary says to log in again.
 * Every hunt ends with a summary (stored for the dashboard, optionally a Windows toast).
 */
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { log } from '../log.js';
import { Applications } from '../apply/plan.js';
import { prepareJobs } from '../apply/service.js';
import { checkDrushimSession, checkSiteSession, getSession, type SessionInfo } from '../browser/site-session.js';
import { hasApplyFlow } from '../apply/drivers.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { rankStoredJob } from '../core/rank.js';
import { emailAlertsEnabled, enabledSources } from '../linkedin/settings.js';
import { showToast } from '../notify/toast.js';
import { runEmailAlertsToCompletion } from './linkedin-run.js';
import { getActiveRun, runToCompletion, waitIdle } from './runner.js';
import { scheduleSettings } from './schedule.js';
import { config } from '../config.js';
import { autoSubmitSettings } from '../apply/auto-submit.js';
import { adapters, SITES } from '../sites/registry.js';

export type HuntTrigger = 'manual' | 'schedule' | 'task' | 'cli';

export interface HuntSummary {
  trigger: HuntTrigger;
  startedAt: string;
  finishedAt: string;
  runs: Array<{ site: string; status?: string; reason?: string | null; inserted: number; scored: number }>;
  found: number;
  /** skipped during this hunt, by reason (status or the reason's first words) */
  skipped: Record<string, number>;
  readyForReview: number;
  autoSubmitted: number;
  failed: number;
  /** every application sent during this hunt (auto-submit) */
  sent?: number;
  /** all applications waiting in the review queue when the hunt ended (this hunt's and earlier ones) */
  waitingForReview?: number;
  /** whether this hunt could send: on, or why it stopped after prepare */
  sending?: string;
  /** the Drushim session expired: discovery-only, log in again */
  loginNeeded: boolean;
  note: string | null;
}

export interface HuntResult extends HuntSummary {
  id: number;
  candidates: number;
  prepared: number;
  before: Record<string, number>;
  after: Record<string, number>;
}

/** "prefilter: seniority: \"Senior\"" → "prefilter: seniority"; "already_applied: on drushim (…)" → "already_applied" */
export function skipReason(status: string, reason: string | null): string {
  if (status !== 'skipped') return status;
  const r = reason ?? '';
  if (r.startsWith('prefilter: ')) return `prefilter: ${r.slice(11).split(':')[0]!.trim()}`;
  if (r.startsWith('duplicate of')) return 'duplicate';
  if (r.startsWith('already_applied')) return 'already_applied';
  return r.split(':')[0]!.trim() || 'skipped';
}

let running = false;
export const huntRunning = () => running;

export interface HuntProgress {
  id: number;
  trigger: HuntTrigger;
  startedAt: string;
  /** what the hunt is doing now ("done" at the end) */
  step: string;
  steps: Array<{ name: string; state: 'running' | 'done' | 'skipped' | 'failed'; detail?: string }>;
  counts: { found: number; scored: number; candidates: number; sent: number; review: number; failed: number };
  /** the current job / page (from the active run) */
  current: string | null;
  finished: boolean;
}
let progress: HuntProgress | null = null;
/** the running (or last) hunt's live progress, with the active run's current stage */
export function huntProgress(): HuntProgress | null {
  if (!progress) return null;
  const run = getActiveRun();
  return { ...progress, current: progress.finished ? null : (run?.stage ?? progress.current) };
}

/** Can the sending happen in this hunt? "on", or why it stops after prepare. */
export function sendingMode(site = 'drushim'): string {
  if (config.DRY_RUN) return 'DRY_RUN is on — plans are prepared, nothing is sent';
  const a = autoSubmitSettings();
  if (a.paused) return 'auto-submit is paused (kill switch) — stopped after prepare';
  if (!a.sites[site]) return `auto-submit is off for ${site} — stopped after prepare (approve in the review queue)`;
  return 'on';
}

export interface HuntOptions {
  trigger?: HuntTrigger;
  /** test seam: the Drushim session check (default: the real one, a headless browser) */
  checkSession?: () => Promise<SessionInfo>;
  /** test seam: the session check of the other sites */
  checkSiteSession?: (site: string) => Promise<SessionInfo>;
  /** test seam: the toast */
  notify?: (title: string, body: string) => void;
}

export async function runHunt(db: DB, opts: HuntOptions = {}): Promise<HuntResult> {
  if (running || getActiveRun()) throw new Error('a run is already active — the hunt was not started');
  running = true;
  const trigger = opts.trigger ?? 'manual';
  const startedAt = nowIso();
  const huntId = Number(db.prepare('INSERT INTO hunts (trigger, started_at) VALUES (?, ?)').run(trigger, startedAt).lastInsertRowid);
  const L = log.child({ hunt: huntId, trigger });
  progress = { id: huntId, trigger, startedAt, step: 'starting', steps: [], counts: { found: 0, scored: 0, candidates: 0, sent: 0, review: 0, failed: 0 }, current: null, finished: false };
  const p = progress;
  const step = (name: string) => {
    p.step = name;
    p.steps.push({ name, state: 'running' });
    return (state: 'done' | 'skipped' | 'failed' = 'done', detail?: string) => Object.assign(p.steps[p.steps.length - 1]!, { state, detail });
  };
  try {
    const repo = new Repo(db);
    const before = repo.statusCounts();
    const lastRun = () => {
      const r = repo.listRuns(1)[0] as { site: string; status?: string; reason?: string | null; stats?: Record<string, number> } | undefined;
      return { site: r?.site ?? '?', status: r?.status, reason: r?.reason ?? null, inserted: r?.stats?.inserted ?? 0, scored: r?.stats?.scored ?? 0 };
    };

    // the sites this hunt can apply on (an adapter and an apply flow), each with its own login
    const applySites = SITES.filter((x) => x.enabled && adapters[x.id] && hasApplyFlow(x.id));
    const sessions = new Map<string, SessionInfo>();
    let end = step('checking the Drushim login');
    for (const site of applySites) {
      if (site.id !== 'drushim') end = step(`checking the ${site.displayName} login`);
      const check = site.id === 'drushim' ? (opts.checkSession ?? checkDrushimSession) : () => (opts.checkSiteSession ?? checkSiteSession)(site.id);
      const session = await check().catch((e: unknown): SessionInfo => ({ state: 'unknown', checkedAt: nowIso(), detail: String(e) }));
      sessions.set(site.id, session);
      if (session.state === 'logged_in') {
        const n = repo.requeueLoginFailures(site.id);
        if (n) L.info({ site: site.id, jobs: n }, 'login valid again — jobs that failed on "not logged in" are back in the queue');
      }
      end(session.state === 'logged_out' ? 'failed' : 'done', session.state === 'logged_in' ? 'logged in' : session.state === 'logged_out' ? 'NOT logged in — discovery only' : `unknown (${session.detail})`);
    }
    if (!applySites.length) end('skipped', 'no site with an apply flow is enabled');
    const loginNeeded = sessions.get('drushim')?.state === 'logged_out';
    L.info({ sessions: Object.fromEntries([...sessions].map(([k, v]) => [k, v.state])) }, 'hunt started');

    const runs: HuntSummary['runs'] = [];
    // job-alert emails first (optional): Drushim jobs found through Indeed links are then read by the Drushim run
    if (emailAlertsEnabled()) {
      end = step(`reading job-alert emails (${enabledSources().join(', ')})`);
      await runEmailAlertsToCompletion(db, { followUp: false });
      const r = lastRun();
      runs.push(r);
      p.counts.found += r.inserted;
      p.counts.scored += r.scored;
      end(r.status === 'done' ? 'done' : 'failed', `${r.status === 'done' ? '' : `${r.status}${r.reason ? ` (${r.reason})` : ''} · `}new ${r.inserted} · scored ${r.scored}`);
    }
    // discovery on every enabled site that has an adapter (Drushim, JobMaster)
    for (const site of SITES.filter((x) => x.enabled && adapters[x.id])) {
      end = step(`discovering on ${site.displayName} → scoring`);
      await runToCompletion(db, site.id, 'full');
      const r = lastRun();
      runs.push(r);
      p.counts.found += r.inserted;
      p.counts.scored += r.scored;
      end(r.status === 'done' ? 'done' : 'failed', `${r.status}${r.reason ? ` (${r.reason})` : ''} · new ${r.inserted} · scored ${r.scored}`);
    }

    const prefs = loadPrefs();
    const limits = effectiveLimits(prefs);
    const apps = new Applications(db);
    const open = (j: { id: string }) => ['needs_review', 'ready', 'approved'].includes(apps.latestForJob(j.id)?.status ?? '');
    const pool = [
      ...repo.listJobs({ status: 'scored', minScore: limits.autoSubmitMinScore, limit: 2000 }).items.filter((j) => !apps.latestForJob(j.id)),
      // queued earlier (e.g. back in the queue after a login failure) and not in review
      ...repo.listJobs({ status: 'queued', limit: 2000 }).items.filter((j) => !open(j)),
    ];
    // per site: logged in (or unknown), highest rank first, within that site's daily limit
    const loggedOut: string[] = [];
    const waiting: string[] = [];
    const candidates: Array<(typeof pool)[number]> = [];
    for (const site of applySites) {
      const mine = pool
        .filter((j) => j.site === site.id)
        .map((j) => ({ ...j, r: rankStoredJob(j, j.score, prefs).rank ?? -Infinity }))
        .sort((x, y) => y.r - x.r)
        .slice(0, Math.max(0, limits.dailyApplyLimit - repo.submittedToday(site.id)));
      if (sessions.get(site.id)?.state === 'logged_out' || getSession(site.id).state === 'logged_out') {
        loggedOut.push(site.displayName);
        if (mine.length) waiting.push(`${mine.length} on ${site.displayName}`);
        continue;
      }
      candidates.push(...mine);
    }

    let note: string | null = null;
    let prepared = 0;
    const modes = applySites.map((x) => [x.id, sendingMode(x.id)] as const);
    const sending = modes.length === 1 ? modes[0]![1] : modes.every(([, m]) => m === 'on') ? 'on' : modes.map(([k, m]) => `${k}: ${m}`).join(' · ');
    p.counts.candidates = candidates.length;
    end = step(modes.some(([, m]) => m === 'on') ? 'preparing → sending what passes the gate' : 'preparing plans (not sending)');
    if (loggedOut.length) {
      note = `${loggedOut.join(', ')} login expired — log in again (dashboard button or npm run login -- <site>). Discovery only there${waiting.length ? `: ${waiting.join(', ')} job(s) ≥ ${limits.autoSubmitMinScore} wait for you` : ''}.`;
    }
    if (candidates.length === 0) note ??= `no new jobs with score ≥ ${limits.autoSubmitMinScore}`;
    else if (!getActiveRun()) {
      prepareJobs(db, candidates.map((j) => j.id));
      await waitIdle();
      prepared = candidates.length;
    }
    end(note && !prepared ? 'skipped' : 'done', note ?? `${prepared} job(s)${sending === 'on' ? '' : ` — ${sending}`}`);

    const skipped = Object.fromEntries(
      (db.prepare("SELECT status, status_reason FROM jobs WHERE updated_at >= ? AND status LIKE 'skipped%'").all(startedAt) as Array<{ status: string; status_reason: string | null }>).reduce(
        (m, r) => m.set(skipReason(r.status, r.status_reason), (m.get(skipReason(r.status, r.status_reason)) ?? 0) + 1),
        new Map<string, number>(),
      ),
    );
    const count = (sql: string) => (db.prepare(sql).get(startedAt) as { n: number }).n;
    const summary: HuntSummary = {
      trigger,
      startedAt,
      finishedAt: nowIso(),
      runs,
      found: runs.reduce((n, r) => n + r.inserted, 0),
      skipped,
      readyForReview: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'needs_review' AND updated_at >= ?"),
      autoSubmitted: count(`SELECT COUNT(*) AS n FROM applications WHERE status = 'submitted' AND submitted_at >= ? AND gate_json LIKE '%"auto":true%'`),
      failed: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND updated_at >= ?"),
      sent: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'submitted' AND submitted_at >= ?"),
      waitingForReview: (db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'needs_review'").get() as { n: number }).n,
      sending,
      loginNeeded: loginNeeded || (applySites.some((x) => x.id === 'drushim') && getSession('drushim').state === 'logged_out'),
      note,
    };
    Object.assign(p.counts, { sent: summary.sent, review: summary.waitingForReview, failed: summary.failed });
    db.prepare('UPDATE hunts SET finished_at = ?, summary_json = ? WHERE id = ?').run(summary.finishedAt, JSON.stringify(summary), huntId);
    L.info(summary, 'hunt finished');

    if (scheduleSettings().toast) {
      const skippedN = Object.values(skipped).reduce((a, b) => a + b, 0);
      const body = summary.loginNeeded
        ? `Log in to Drushim again. Found ${summary.found} new job(s), discovery only.`
        : `Found ${summary.found} · skipped ${skippedN} · ready for review ${summary.readyForReview} · auto-submitted ${summary.autoSubmitted} · failed ${summary.failed}`;
      (opts.notify ?? showToast)('JobHunter hunt finished', body);
    }
    p.step = 'done';
    return { ...summary, id: huntId, candidates: candidates.length, prepared, before, after: repo.statusCounts() };
  } catch (e) {
    p.step = `failed: ${e instanceof Error ? e.message : String(e)}`;
    const last = p.steps[p.steps.length - 1];
    if (last?.state === 'running') last.state = 'failed';
    db.prepare('UPDATE hunts SET finished_at = ?, summary_json = ? WHERE id = ?').run(nowIso(), JSON.stringify({ trigger, startedAt, error: e instanceof Error ? e.message : String(e) }), huntId);
    throw e;
  } finally {
    p.finished = true;
    running = false;
  }
}

/** The end-of-session summary: what happened, and whether JobHunter can be closed (nothing still running). */
export function doneReport(h: HuntSummary & { error?: string }, still: string[]): string[] {
  const skipped = Object.entries(h.skipped ?? {}).sort((a, b) => b[1] - a[1]);
  const out = [
    still.length ? `Still running: ${still.join(' · ')} — wait before closing.` : 'Done. Safe to close / shut down.',
  ];
  if (h.error) out.push(`The run failed: ${h.error}`);
  else {
    out.push(`found ${h.found} new job(s)`);
    out.push(`skipped ${skipped.reduce((n, [, v]) => n + v, 0)}${skipped.length ? ` (${skipped.map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
    out.push(`sent ${h.sent ?? h.autoSubmitted}${h.sending && h.sending !== 'on' ? ` — ${h.sending}` : ''}`);
    out.push(`waiting for your review ${h.waitingForReview ?? h.readyForReview}`);
    out.push(`failed ${h.failed}`);
    if (h.loginNeeded) out.push('Drushim login expired — log in again (dashboard button or npm run login -- drushim); this run was discovery-only.');
    if (h.note) out.push(h.note);
  }
  return out;
}

export function recentHunts(db: DB, limit = 10): Array<HuntSummary & { id: number; error?: string }> {
  return (db.prepare('SELECT id, summary_json FROM hunts WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit) as Array<{ id: number; summary_json: string }>).map((r) => ({
    id: r.id,
    ...(JSON.parse(r.summary_json) as HuntSummary & { error?: string }),
  }));
}
