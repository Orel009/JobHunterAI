/**
 * One full hunt (npm start -- --hunt): Drushim discover → score; LinkedIn alert emails (only when that optional
 * feature is on); then prepare plans for the best new Drushim jobs within today's limit. Never submits.
 */
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { Applications } from '../apply/plan.js';
import { prepareJobs } from '../apply/service.js';
import { getSession } from '../browser/site-session.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { rankStoredJob } from '../core/rank.js';
import { linkedInEnabled } from '../linkedin/settings.js';
import { runLinkedInToCompletion } from './linkedin-run.js';
import { getActiveRun, runToCompletion, waitIdle } from './runner.js';

export interface HuntResult {
  runs: Array<{ site: string; status?: string; reason?: string | null; inserted: number; scored: number }>;
  candidates: number;
  prepared: number;
  /** why nothing was prepared, if so */
  note: string | null;
  before: Record<string, number>;
  after: Record<string, number>;
}

export async function runHunt(db: DB): Promise<HuntResult> {
  const repo = new Repo(db);
  const before = repo.statusCounts();
  const lastRun = () => {
    const r = repo.listRuns(1)[0] as { site: string; status?: string; reason?: string | null; stats?: Record<string, number> } | undefined;
    return { site: r?.site ?? '?', status: r?.status, reason: r?.reason ?? null, inserted: r?.stats?.inserted ?? 0, scored: r?.stats?.scored ?? 0 };
  };

  await runToCompletion(db, 'drushim', 'full');
  const runs = [lastRun()];
  if (linkedInEnabled()) {
    await runLinkedInToCompletion(db);
    runs.push(lastRun());
  }

  const limits = effectiveLimits(loadPrefs());
  const apps = new Applications(db);
  const room = Math.max(0, limits.dailyApplyLimit - repo.submittedToday());
  const prefs = loadPrefs();
  // highest rank first: the daily limit is spent on the best jobs. Only sites with an automated apply flow.
  const candidates = repo
    .listJobs({ status: 'scored', minScore: limits.autoSubmitMinScore, limit: 2000 })
    .items.filter((j) => j.site === 'drushim' && !apps.latestForJob(j.id))
    .map((j) => ({ ...j, r: rankStoredJob(j, j.score, prefs).rank ?? -Infinity }))
    .sort((a, b) => b.r - a.r)
    .slice(0, room);

  let note: string | null = null;
  let prepared = 0;
  if (getSession('drushim').state === 'logged_out') note = `${candidates.length} job(s) ≥ ${limits.autoSubmitMinScore} — not preparing: not logged in to Drushim`;
  else if (candidates.length === 0) note = `no new jobs with score ≥ ${limits.autoSubmitMinScore}`;
  else if (!getActiveRun()) {
    prepareJobs(db, candidates.map((j) => j.id));
    await waitIdle();
    prepared = candidates.length;
  }
  return { runs, candidates: candidates.length, prepared, note, before, after: repo.statusCounts() };
}
