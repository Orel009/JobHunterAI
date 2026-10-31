import { config } from '../config.js';
import { log } from '../log.js';
import type { DB } from '../db/index.js';
import { Repo, type StoredJob } from '../db/repo.js';
import { getAdapter } from '../sites/registry.js';
import type { SiteContext } from '../sites/types.js';
import { BlockedError, closeContext, getPage } from '../browser/session.js';
import { toJob } from '../core/job.js';
import { findCrossSiteDuplicate } from '../core/dedupe.js';
import { excludedCompanyMatch, prefilter, scoringRole } from '../core/prefilter.js';
import { jobSalary } from '../core/salary.js';
import { effectiveLimits, loadPrefs, searchPlan } from '../core/prefs.js';
import { experienceInput, extractRequiredYears } from '../core/experience.js';
import { candidateContext, scoreJob } from '../llm/score.js';
import { LlmPausedError } from '../llm/types.js';
import { candidateGender, loadProfile, skillAliasGroups } from '../profile/facts.js';

/** enrich = fetch missing details for prefilter-passing jobs, then score (no searching) */
export type RunKind = 'discover' | 'score' | 'full' | 'enrich';

export interface RunStats {
  queries: number;
  seen: number;
  inserted: number;
  updated: number;
  duplicates: number;
  prefilterPassed: number;
  prefilterSkipped: number;
  detailsFetched: number;
  scored: number;
  scoreErrors: number;
}

export interface ActiveRun {
  id: number;
  site: string;
  kind: string;
  startedAt: string;
  stage: string;
  stats: RunStats & Record<string, number>;
  controller: AbortController;
}

export type TaskFn = (run: ActiveRun, repo: Repo, L: typeof log) => Promise<void>;

let active: ActiveRun | null = null;
/** runs to start once the current one has finished (e.g. scoring after the profile is approved) */
const followUps: Array<() => void> = [];

/** Starts the run now, or right after the current run when one is active. */
export function startWhenIdle(start: () => void): 'started' | 'queued' {
  if (!active) {
    start();
    return 'started';
  }
  followUps.push(start);
  return 'queued';
}

export const getActiveRun = () =>
  active && { id: active.id, site: active.site, kind: active.kind, startedAt: active.startedAt, stage: active.stage, stats: active.stats };

export function stopRun(): boolean {
  if (!active) return false;
  active.controller.abort();
  log.warn({ runId: active.id }, 'stop requested');
  return true;
}

/** Starts a discovery/scoring run in the background. */
export function startRun(db: DB, site: string, kind: RunKind): number {
  getAdapter(site); // validates site
  return startTask(db, site, kind, async (run, repo, L) => {
    if (kind === 'discover' || kind === 'full') await discover(repo, run, L);
    if (kind === 'enrich') await details(repo, run, L, loadPrefs());
    if (kind !== 'discover') await score(repo, run, L);
  });
}

/** Runs any browser task exclusively (one at a time: there is one browser profile and one tab). */
export function startTask(db: DB, site: string, kind: string, fn: TaskFn): number {
  if (active) throw new Error(`A run is already active (#${active.id} ${active.site}/${active.kind})`);
  const repo = new Repo(db);
  const id = repo.startRun(site, kind);
  const run: ActiveRun = {
    id,
    site,
    kind,
    startedAt: new Date().toISOString(),
    stage: 'starting',
    controller: new AbortController(),
    stats: { queries: 0, seen: 0, inserted: 0, updated: 0, duplicates: 0, prefilterPassed: 0, prefilterSkipped: 0, detailsFetched: 0, scored: 0, scoreErrors: 0 },
  };
  active = run;
  void execute(repo, run, fn).finally(() => {
    active = null;
    const next = followUps.shift();
    if (next) {
      try {
        next();
      } catch (e) {
        log.warn({ err: e instanceof Error ? e.message : String(e) }, 'follow-up run not started');
      }
    }
  });
  return id;
}

/** Same as startRun but awaits completion (CLI). */
export async function runToCompletion(db: DB, site: string, kind: RunKind): Promise<void> {
  startRun(db, site, kind);
  await waitIdle();
}

export async function waitIdle(): Promise<void> {
  while (active) await new Promise((r) => setTimeout(r, 300));
}

async function execute(repo: Repo, run: ActiveRun, fn: TaskFn): Promise<void> {
  const L = log.child({ runId: run.id, site: run.site, kind: run.kind });
  try {
    await fn(run, repo, L);
    const status = run.controller.signal.aborted ? 'stopped' : 'done';
    repo.finishRun(run.id, status, run.stats);
    L.info({ stats: run.stats }, `run ${status}`);
  } catch (e) {
    if (e instanceof BlockedError) {
      repo.finishRun(run.id, 'blocked', run.stats, e.reason);
      L.error({ reason: e.reason }, 'run BLOCKED — not retrying; check the site manually');
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      repo.finishRun(run.id, 'failed', run.stats, msg);
      L.error({ err: msg }, 'run failed');
    }
  } finally {
    await closeContext();
  }
}

async function discover(repo: Repo, run: ActiveRun, L: typeof log): Promise<void> {
  const prefs = loadPrefs();
  const limits = effectiveLimits(prefs);
  const adapter = getAdapter(run.site);
  const plan = searchPlan(prefs);
  if (plan.length === 0) throw new Error('No search queries: add enabled roleTypes (with queries) to preferences.yaml');

  const page = await getPage();
  const ctx: SiteContext = { page, maxPages: limits.maxPagesPerRun, signal: run.controller.signal };

  run.stage = 'searching';
  for (const { query: keyword, roleIds } of plan) {
    if (run.controller.signal.aborted) return;
    run.stats.queries++;
    L.info({ keyword, roles: roleIds }, 'query');
    for await (const raw of adapter.search({ keyword }, ctx)) {
      run.stats.seen++;
      const job = toJob(raw);
      const { outcome, job: stored } = repo.upsertJob(job);
      repo.addRoleTypes(stored.id, roleIds);
      if (outcome === 'inserted') {
        run.stats.inserted++;
        const dup = findCrossSiteDuplicate(job, new Date(), repo.dedupeCandidates(job.companyNorm, job.titleNorm, job.site), config.DEDUPE_WINDOW_DAYS);
        if (dup) {
          repo.markDuplicate(stored.id, dup.id);
          run.stats.duplicates++;
        }
      } else if (outcome === 'updated') run.stats.updated++;
    }
  }

  // jobs this account already applied to never reach scoring or the review queue (refreshed on every run)
  if (adapter.appliedJobs) {
    run.stage = 'checking applied jobs';
    try {
      const applied = await adapter.appliedJobs(ctx);
      run.stats.alreadyApplied = repo.markAlreadyApplied(run.site, applied);
      L.info({ appliedOnSite: applied.size, skipped: run.stats.alreadyApplied }, 'already-applied jobs skipped');
    } catch (e) {
      L.warn({ err: e instanceof Error ? e.message : String(e) }, 'could not read the already-applied list; the apply step still checks each job');
    }
  }

  run.stage = 'prefilter';
  applyPrefilter(repo, run, prefs);

  await details(repo, run, L, prefs, ctx);
}

/**
 * Full job pages for prefilter-passing jobs. One failing page is logged and skipped (the job keeps its card text and
 * is retried next run); a challenge page stops the run; 3 page errors in a row stop it as possible rate limiting.
 */
async function details(repo: Repo, run: ActiveRun, L: typeof log, prefs: ReturnType<typeof loadPrefs>, ctxIn?: SiteContext): Promise<void> {
  const adapter = getAdapter(run.site);
  const ctx = ctxIn ?? { page: await getPage(), maxPages: 1, signal: run.controller.signal };
  run.stage = 'details';
  run.stats.detailsErrors = 0;
  let streak = 0;
  for (const j of repo.jobsNeedingDetails(run.site)) {
    if (run.controller.signal.aborted) return;
    try {
      const detailed = await adapter.getDetails(j, ctx);
      streak = 0;
      if (!detailed) {
        repo.setStatus(j.id, 'skipped', 'job no longer available');
        continue;
      }
      repo.upsertJob(toJob(detailed));
      run.stats.detailsFetched++;
    } catch (e) {
      if (e instanceof BlockedError) throw e;
      run.stats.detailsErrors++;
      streak++;
      L.warn({ job: j.title, url: j.url, err: e instanceof Error ? e.message.split('\n')[0] : String(e) }, 'details failed — skipping this job page');
      if (streak >= 3) throw new BlockedError('3 job pages failed in a row — possible rate limiting; stopping');
    }
  }
  // Details can change title/location → re-run the prefilter for those.
  applyPrefilter(repo, run, prefs);
}

function aliasGroupsOrNone(): string[][] {
  try {
    return skillAliasGroups(loadProfile());
  } catch {
    return []; // invalid profile: the scorer reports it; the prefilter works without aliases
  }
}

const prefilterJob = (j: StoredJob, prefs: ReturnType<typeof loadPrefs>, aliasGroups: string[][]) =>
  prefilter({ ...j, regions: ((j.raw as { regions?: unknown } | null)?.regions as string[] | undefined) ?? [] }, prefs, { aliasGroups });

/** Reads the posted salary of new / changed jobs (deterministic, no LLM). */
export const syncSalaries = (repo: Repo) => repo.syncSalaries((j) => jobSalary(j));

export function applyPrefilter(repo: Repo, run: ActiveRun, prefs: ReturnType<typeof loadPrefs>): void {
  const aliasGroups = aliasGroupsOrNone();
  syncSalaries(repo);
  for (const j of repo.jobsNeedingPrefilter(run.site)) {
    const r = prefilterJob(j, prefs, aliasGroups);
    repo.setPrefilter(j.id, r.pass, r.reason, r.status);
    if (r.pass) run.stats.prefilterPassed++;
    else run.stats.prefilterSkipped++;
  }
}

/**
 * After Preferences change: the prefilter again over every job not past scoring (discovered, scored, or skipped by
 * the prefilter), so new rules apply without searching again. Newly passing jobs get details / a score next run.
 */
export function refilterExisting(repo: Repo, prefs = loadPrefs()): { checked: number; newlySkipped: number; restored: number } {
  const aliasGroups = aliasGroupsOrNone();
  const out = { checked: 0, newlySkipped: 0, restored: 0 };
  syncSalaries(repo);
  for (const j of repo.jobsForRefilter()) {
    out.checked++;
    const r = prefilterJob(j, prefs, aliasGroups);
    const wasSkipped = j.status === 'skipped' || j.status === 'skipped_salary' || j.status === 'skipped_company';
    if (!r.pass && !wasSkipped) out.newlySkipped++;
    if (r.pass && wasSkipped) out.restored++;
    repo.refilter(j.id, r.pass, r.reason, r.status);
  }
  // jobs already in the apply flow: an excluded company takes them out (and closes their open applications)
  for (const j of repo.openApplyJobs()) {
    const match = excludedCompanyMatch(j.company, prefs.filters.excludeCompanies);
    if (!match) continue;
    out.checked++;
    out.newlySkipped++;
    repo.closeForExcludedCompany(j.id, `excluded company: ${j.company} (matches "${match}")`);
  }
  return out;
}

/** Prefilter + experience cap + LLM score for the run's site (no browser). */
export async function score(repo: Repo, run: ActiveRun, L: typeof log): Promise<void> {
  run.stage = 'scoring';
  const prefs = loadPrefs();
  applyPrefilter(repo, run, prefs);
  // new or changed jobs, plus scored jobs that preferences now treat as another role type (judged for the wrong role)
  const roleChanged = repo.scoredWithRole(run.site).filter((j) => (scoringRole(j, prefs)?.id ?? null) !== j.scoredRole);
  const todo = [...repo.jobsNeedingScore(run.site), ...roleChanged];
  run.stats.roleChanged = roleChanged.length;
  let candidate: string;
  try {
    candidate = candidateContext(prefs);
  } catch (e) {
    // no approved profile: keep what was discovered; scoring starts by itself once the profile is approved
    run.stats.waitingForProfile = todo.length;
    L.warn({ jobs: todo.length }, `scoring skipped — ${(e as Error).message}`);
    return;
  }
  const gender = candidateGender();
  run.stats.skippedExperience = 0;
  L.info({ count: todo.length, model: config.OLLAMA_MODEL_ANALYZE, maxRequiredYears: prefs.maxRequiredYears }, 'scoring');
  for (const j of todo) {
    if (run.controller.signal.aborted) return;
    // experience cap, deterministic first: skip BEFORE the LLM when the text states too many years
    const ex = extractRequiredYears(experienceInput(j));
    repo.setExperience(j.id, { years: ex.requiredYears, source: ex.requiredYears !== null ? 'regex' : null, text: ex.text, juniorText: ex.juniorText });
    if (ex.requiredYears !== null && ex.requiredYears > prefs.maxRequiredYears) {
      repo.setStatus(j.id, 'skipped_experience', `requires ${ex.requiredYears}y (regex): "${ex.text}"`);
      run.stats.skippedExperience++;
      continue;
    }
    try {
      const t0 = Date.now();
      const role = scoringRole(j, prefs);
      const s = await scoreJob(j, candidate, { cache: repo, role, gender });
      repo.saveScore(j.id, { ...s, contentHash: j.contentHash, roleType: role?.id ?? null });
      run.stats.scored++;
      if (s.isTrainingProgram) {
        repo.setStatus(j.id, 'skipped_not_a_job', 'training program / course, not a job (scorer)');
        run.stats.notAJob = (run.stats.notAJob ?? 0) + 1;
        continue;
      }
      // LLM fallback only when the regex found nothing (regex wins when both exist)
      if (ex.requiredYears === null && s.requiredYearsMin !== null) {
        repo.setExperience(j.id, { years: s.requiredYearsMin, source: 'llm', text: s.requiredYearsQuote, juniorText: ex.juniorText });
        if (s.requiredYearsMin > prefs.maxRequiredYears) {
          repo.setStatus(j.id, 'skipped_experience', `requires ${s.requiredYearsMin}y (llm): "${s.requiredYearsQuote ?? ''}"`);
          run.stats.skippedExperience++;
        }
      }
      L.info({ job: j.title, company: j.company, role: role?.id, score: s.score, ms: Date.now() - t0, cached: s.cached }, 'scored');
    } catch (e) {
      run.stats.scoreErrors++;
      L.error({ job: j.title, err: e instanceof Error ? e.message : String(e) }, 'score failed');
      if (e instanceof LlmPausedError) throw e; // daily token limit: stop the run, don't skip jobs
      if (e instanceof Error && /ECONNREFUSED|fetch failed/.test(e.message)) throw new Error(`LLM provider not reachable (${e.message})`);
    }
  }
}
