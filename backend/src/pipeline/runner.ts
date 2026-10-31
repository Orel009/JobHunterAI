import { config } from '../config.js';
import { log } from '../log.js';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { getAdapter } from '../sites/registry.js';
import type { SiteContext } from '../sites/types.js';
import { BlockedError, closeContext, getPage } from '../browser/session.js';
import { toJob } from '../core/job.js';
import { findCrossSiteDuplicate } from '../core/dedupe.js';
import { prefilter, primaryRole } from '../core/prefilter.js';
import { effectiveLimits, loadPrefs, searchPlan } from '../core/prefs.js';
import { experienceInput, extractRequiredYears } from '../core/experience.js';
import { candidateContext, scoreJob } from '../llm/score.js';
import { loadProfile, skillAliasGroups } from '../profile/facts.js';

export type RunKind = 'discover' | 'score' | 'full';

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
    if (kind !== 'score') await discover(repo, run, L);
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

  run.stage = 'prefilter';
  applyPrefilter(repo, run, prefs);

  run.stage = 'details';
  for (const j of repo.jobsNeedingDetails(run.site)) {
    if (run.controller.signal.aborted) return;
    const detailed = await adapter.getDetails(j, ctx);
    if (!detailed) {
      repo.setStatus(j.id, 'skipped', 'job no longer available');
      continue;
    }
    repo.upsertJob(toJob(detailed));
    run.stats.detailsFetched++;
  }
  // Details can change title/location → re-run the prefilter for those.
  applyPrefilter(repo, run, prefs);
}

function applyPrefilter(repo: Repo, run: ActiveRun, prefs: ReturnType<typeof loadPrefs>): void {
  let aliasGroups: string[][] = [];
  try {
    aliasGroups = skillAliasGroups(loadProfile());
  } catch {
    /* invalid profile: the scorer reports it; prefilter works without aliases */
  }
  for (const j of repo.jobsNeedingPrefilter(run.site)) {
    const r = prefilter(j, prefs, { aliasGroups });
    repo.setPrefilter(j.id, r.pass, r.reason);
    if (r.pass) run.stats.prefilterPassed++;
    else run.stats.prefilterSkipped++;
  }
}

async function score(repo: Repo, run: ActiveRun, L: typeof log): Promise<void> {
  run.stage = 'scoring';
  const prefs = loadPrefs();
  applyPrefilter(repo, run, prefs);
  const candidate = candidateContext(prefs);
  const todo = repo.jobsNeedingScore(run.site);
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
      const role = primaryRole(j, prefs);
      const s = await scoreJob(j, candidate, { cache: repo, role });
      repo.saveScore(j.id, { ...s, contentHash: j.contentHash, roleType: role?.id ?? null });
      run.stats.scored++;
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
      if (e instanceof Error && /ECONNREFUSED|fetch failed/.test(e.message)) throw new Error(`Ollama not reachable at ${config.OLLAMA_URL}`);
    }
  }
}
