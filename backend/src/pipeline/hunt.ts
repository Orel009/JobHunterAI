/**
 * One full hunt (npm start -- --hunt, the dashboard, the in-app schedule or Windows Task Scheduler):
 * Drushim discover → score; LinkedIn alert emails (only when that optional feature is on); then prepare plans for the
 * best new Drushim jobs within today's limit (auto-submit only if you turned it on and its gate passes).
 * If the Drushim login has expired, the hunt stays discovery-only and its summary says to log in again.
 * Every hunt ends with a summary (stored for the dashboard, optionally a Windows toast).
 */
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { log } from '../log.js';
import { Applications } from '../apply/plan.js';
import { prepareJobs } from '../apply/service.js';
import { checkDrushimSession, getSession, type SessionInfo } from '../browser/site-session.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { rankStoredJob } from '../core/rank.js';
import { linkedInEnabled } from '../linkedin/settings.js';
import { showToast } from '../notify/toast.js';
import { runLinkedInToCompletion } from './linkedin-run.js';
import { getActiveRun, runToCompletion, waitIdle } from './runner.js';
import { scheduleSettings } from './schedule.js';

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

export interface HuntOptions {
  trigger?: HuntTrigger;
  /** test seam: the session check (default: the real one, a headless browser) */
  checkSession?: () => Promise<SessionInfo>;
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
  try {
    const repo = new Repo(db);
    const before = repo.statusCounts();
    const lastRun = () => {
      const r = repo.listRuns(1)[0] as { site: string; status?: string; reason?: string | null; stats?: Record<string, number> } | undefined;
      return { site: r?.site ?? '?', status: r?.status, reason: r?.reason ?? null, inserted: r?.stats?.inserted ?? 0, scored: r?.stats?.scored ?? 0 };
    };

    // is the Drushim login still valid? (an expired one keeps this hunt discovery-only)
    const session = await (opts.checkSession ?? checkDrushimSession)().catch((e: unknown): SessionInfo => ({ state: 'unknown', checkedAt: nowIso(), detail: String(e) }));
    const loginNeeded = session.state === 'logged_out';
    if (session.state === 'logged_in') {
      const n = repo.requeueLoginFailures('drushim');
      if (n) L.info({ jobs: n }, 'login valid again — jobs that failed on "not logged in" are back in the queue');
    }
    L.info({ session: session.state }, 'hunt started');

    await runToCompletion(db, 'drushim', 'full');
    const runs = [lastRun()];
    if (linkedInEnabled()) {
      await runLinkedInToCompletion(db);
      runs.push(lastRun());
    }

    const prefs = loadPrefs();
    const limits = effectiveLimits(prefs);
    const apps = new Applications(db);
    const room = Math.max(0, limits.dailyApplyLimit - repo.submittedToday('drushim'));
    // highest rank first: the daily limit is spent on the best jobs. Only sites with an automated apply flow.
    const open = (j: { id: string }) => ['needs_review', 'ready', 'approved'].includes(apps.latestForJob(j.id)?.status ?? '');
    const candidates = [
      ...repo.listJobs({ status: 'scored', minScore: limits.autoSubmitMinScore, limit: 2000 }).items.filter((j) => !apps.latestForJob(j.id)),
      // queued earlier (e.g. back in the queue after a login failure) and not in review
      ...repo.listJobs({ status: 'queued', limit: 2000 }).items.filter((j) => !open(j)),
    ]
      .filter((j) => j.site === 'drushim')
      .map((j) => ({ ...j, r: rankStoredJob(j, j.score, prefs).rank ?? -Infinity }))
      .sort((a, b) => b.r - a.r)
      .slice(0, room);

    let note: string | null = null;
    let prepared = 0;
    if (loginNeeded || getSession('drushim').state === 'logged_out') {
      note = `Drushim login expired — log in again (dashboard button or npm run login -- drushim). Discovery only: ${candidates.length} job(s) ≥ ${limits.autoSubmitMinScore} wait for you.`;
    } else if (candidates.length === 0) note = `no new jobs with score ≥ ${limits.autoSubmitMinScore}`;
    else if (!getActiveRun()) {
      prepareJobs(db, candidates.map((j) => j.id));
      await waitIdle();
      prepared = candidates.length;
    }

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
      loginNeeded: loginNeeded || getSession('drushim').state === 'logged_out',
      note,
    };
    db.prepare('UPDATE hunts SET finished_at = ?, summary_json = ? WHERE id = ?').run(summary.finishedAt, JSON.stringify(summary), huntId);
    L.info(summary, 'hunt finished');

    if (scheduleSettings().toast) {
      const skippedN = Object.values(skipped).reduce((a, b) => a + b, 0);
      const body = summary.loginNeeded
        ? `Log in to Drushim again. Found ${summary.found} new job(s), discovery only.`
        : `Found ${summary.found} · skipped ${skippedN} · ready for review ${summary.readyForReview} · auto-submitted ${summary.autoSubmitted} · failed ${summary.failed}`;
      (opts.notify ?? showToast)('JobHunter hunt finished', body);
    }
    return { ...summary, id: huntId, candidates: candidates.length, prepared, before, after: repo.statusCounts() };
  } catch (e) {
    db.prepare('UPDATE hunts SET finished_at = ?, summary_json = ? WHERE id = ?').run(nowIso(), JSON.stringify({ trigger, startedAt, error: e instanceof Error ? e.message : String(e) }), huntId);
    throw e;
  } finally {
    running = false;
  }
}

export function recentHunts(db: DB, limit = 10): Array<HuntSummary & { id: number; error?: string }> {
  return (db.prepare('SELECT id, summary_json FROM hunts WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit) as Array<{ id: number; summary_json: string }>).map((r) => ({
    id: r.id,
    ...(JSON.parse(r.summary_json) as HuntSummary & { error?: string }),
  }));
}
