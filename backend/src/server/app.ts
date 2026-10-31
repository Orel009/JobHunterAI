import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { log, logBus, recentLogs, type LogLine } from '../log.js';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { SITES } from '../sites/registry.js';
import { JOB_STATUSES } from '../sites/types.js';
import { getActiveRun, refilterExisting, startRun, startTask, stopRun, syncSalaries } from '../pipeline/runner.js';
import { scorePending } from '../pipeline/score-pending.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { byRank, rankStoredJob } from '../core/rank.js';
import { marketStats } from '../core/market.js';
import { listLocalModels } from '../llm/llm.js';
import { taskConfig } from '../llm/settings.js';
import { usageReport } from '../llm/usage.js';
import { registerLlmRoutes } from './llm-routes.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerLinkedInRoutes } from './linkedin-routes.js';
import { registerHistoryRoutes } from './history-routes.js';
import { autoSubmitSettings, effectiveMinRank, pauseAutoSubmit, saveAutoSubmitSettings } from '../apply/auto-submit.js';
import { linkedInEnabled } from '../linkedin/settings.js';
import { prepareJobs, ServiceError } from '../apply/service.js';
import { registerApplyRoutes } from './apply-routes.js';
import { registerCvRoutes, registerEditorRoutes } from './editor-routes.js';
import fs from 'node:fs';
import path from 'node:path';
import { allSessions, checkDrushimSession, getSession } from '../browser/site-session.js';

const OFF_FIELD = /^(seniority|excluded title|no include keyword|role type disabled|excluded company)/;

export function buildApp(db: DB, opts: { staticDir?: string } = {}) {
  // No per-request logging (the dashboard polls); errors are logged below.
  const app = Fastify({ logger: false });
  const repo = new Repo(db);
  syncSalaries(repo); // posted salary of jobs stored before this version (or whose text changed)

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof z.ZodError ? 400 : err instanceof ServiceError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) log.error({ url: req.url, err: err instanceof Error ? err.message : String(err) }, 'http error');
    reply.status(status).send({ error: err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err) });
  });

  app.get('/api/status', async () => {
    const prefs = loadPrefs();
    const tasks = { analyze: taskConfig('analyze'), write: taskConfig('write') };
    const usesOllama = tasks.analyze.provider === 'ollama' || tasks.write.provider === 'ollama';
    let ollama: { ok: boolean; models: string[] } = { ok: false, models: [] };
    if (usesOllama) {
      try {
        ollama = { ok: true, models: await listLocalModels() };
      } catch {
        /* offline */
      }
    }
    const usage = await usageReport(1).catch(() => null);
    return {
      dryRun: config.DRY_RUN,
      activeRun: getActiveRun(),
      today: { submitted: repo.submittedToday() },
      limits: effectiveLimits(prefs),
      counts: repo.statusCounts(),
      llm: {
        ...tasks,
        ollama: usesOllama ? { ok: ollama.ok, missing: (['analyze', 'write'] as const).filter((t) => tasks[t].provider === 'ollama' && !ollama.models.some((m) => m === tasks[t].model || m === `${tasks[t].model}:latest`)) } : null,
        cloud: tasks.analyze.provider !== 'ollama' || tasks.write.provider !== 'ollama',
        tokensToday: usage?.today.apiTokens ?? 0,
        tokenLimit: usage?.limit ?? 0,
      },
      sites: SITES,
      /** optional LinkedIn job alerts (email); the LinkedIn screen and filter exist only while this is on */
      linkedin: { enabled: linkedInEnabled() },
      /** auto-submit (off by default): per-site toggles, the kill switch and the effective minimum rank */
      autoSubmit: { ...autoSubmitSettings(), minRankEffective: effectiveMinRank() },
      sessions: allSessions(),
      roleTypes: loadPrefs().roleTypes.map((r) => ({ id: r.id, label: r.label ?? r.id, tier: r.tier, enabled: r.enabled })),
      maxRequiredYears: loadPrefs().maxRequiredYears,
      /** jobs that passed the prefilter and have no current score (e.g. discovered before the profile was approved) */
      waitingForScore: repo.jobsNeedingScore().length,
      pendingQuestions: (db.prepare("SELECT COUNT(*) AS n FROM answers WHERE status = 'pending'").get() as { n: number }).n,
    };
  });

  const JobsQuery = z.object({
    site: z.string().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    q: z.string().optional(),
    roleType: z.string().optional(),
    /** default list: hide skipped_* (a 'show skipped' toggle sends 0) */
    hideSkipped: z.enum(['0', '1']).optional().transform((v) => v === '1'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  });
  /** Sorted by rank = score + experienceBoost + tierBoost (unscored last), paginated after ranking. */
  app.get('/api/jobs', async (req) => {
    const q = JobsQuery.parse(req.query);
    const prefs = loadPrefs();
    const all = repo.listJobs({ ...q, limit: 5000, offset: 0 });
    const ranked = all.items.map((j) => ({ ...j, rank: rankStoredJob(j, j.score, prefs) })).sort(byRank);
    return { total: all.total, items: ranked.slice(q.offset, q.offset + q.limit) };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = repo.getJob(req.params.id);
    if (!job) return reply.status(404).send({ error: 'not found' });
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/skip', async (req, reply) => {
    if (!repo.getJob(req.params.id)) return reply.status(404).send({ error: 'not found' });
    repo.setStatus(req.params.id, 'skipped', 'skipped manually');
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/unskip', async (req, reply) => {
    const job = repo.getJob(req.params.id);
    if (!job) return reply.status(404).send({ error: 'not found' });
    repo.setStatus(req.params.id, 'discovered', null);
    return { ok: true };
  });

  /** Queues the job and starts preparing its plan (opens the apply panel, never submits). */
  app.post<{ Params: { id: string } }>('/api/jobs/:id/apply', async (req, reply) => {
    const job = repo.getJob(req.params.id);
    if (!job) return reply.status(404).send({ error: 'not found' });
    assertCanApply(job.site);
    if (getActiveRun()) {
      repo.setStatus(job.id, 'queued', 'waiting for the current run to finish');
      return { ok: true, note: 'queued — click "Prepare queued" when the current run finishes' };
    }
    return { ok: true, runId: prepareJobs(db, [job.id]), note: 'preparing plan…' };
  });

  /** Posted-salary stats per role type × required years over the last 30/60/90 days (core/market.ts). */
  app.get('/api/market', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().refine((d) => [30, 60, 90].includes(d)).default(30) }).parse(req.query);
    syncSalaries(repo);
    // your market = jobs in your field: not those the title filters reject (wrong field, too senior, excluded company);
    // location and salary skips stay in
    const jobs = repo.listJobs({ limit: 100_000 }).items.filter((j) => !j.duplicateOf && !OFF_FIELD.test(j.prefilterReason ?? ''));
    return marketStats(jobs, loadPrefs(), { days });
  });

  registerApplyRoutes(app, db);
  registerEditorRoutes(app, {
    onProfileApproved: () => scorePending(db),
    onPreferencesSaved: () => {
      const r = refilterExisting(repo);
      log.info(r, 'preferences saved — prefilter re-run over existing jobs');
      return r;
    },
  });
  registerLlmRoutes(app);
  registerOnboardingRoutes(app, db);
  registerLinkedInRoutes(app, db);
  registerHistoryRoutes(app, db);

  // ---------- auto-submit (off by default) ----------
  app.get('/api/auto-submit', async () => ({ ...autoSubmitSettings(), minRankEffective: effectiveMinRank(), dryRun: config.DRY_RUN, minRankEnv: config.AUTO_SUBMIT_MIN_RANK }));
  app.put('/api/auto-submit', async (req) => {
    const b = z
      .object({ sites: z.record(z.string(), z.boolean()).optional(), minRank: z.number().min(0).max(200).nullable().optional() })
      .parse(req.body ?? {});
    const cur = autoSubmitSettings();
    const next = saveAutoSubmitSettings({ ...(b.sites ? { sites: { ...cur.sites, ...b.sites } } : {}), ...(b.minRank !== undefined ? { minRank: b.minRank } : {}) });
    log.warn({ sites: next.sites, minRank: effectiveMinRank(next) }, 'auto-submit settings changed');
    return { ...next, minRankEffective: effectiveMinRank(next) };
  });
  /** the kill switch: stops auto-submit for every site immediately (checked again right before every final click) */
  app.post('/api/auto-submit/pause', async () => {
    const s = pauseAutoSubmit();
    log.warn('AUTO-SUBMIT PAUSED for all sites');
    return s;
  });
  app.post('/api/auto-submit/resume', async () => {
    const s = saveAutoSubmitSettings({ paused: false, pausedAt: null });
    log.warn('auto-submit resumed');
    return s;
  });
  registerCvRoutes(app, {
    cache: repo,
    rescore: () => {
      const n = repo.invalidateScores();
      log.info({ jobs: n }, 're-scoring active jobs after a profile change');
      return { runId: startRun(db, 'drushim', 'score'), jobs: n } as { runId: number };
    },
  });

  /** Re-check the site login (e.g. after `npm run login -- drushim` in another terminal). Uses the browser, so it is a run. */
  app.post('/api/session/check', async (_req, reply) => {
    try {
      return { runId: startTask(db, 'drushim', 'session_check', async () => void (await checkDrushimSession())) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });

  const RunBody = z.object({ site: z.string(), kind: z.enum(['discover', 'score', 'full']).default('full') });
  app.post('/api/runs', async (req, reply) => {
    const body = RunBody.parse(req.body ?? {});
    try {
      return { id: startRun(db, body.site, body.kind) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });
  app.post('/api/runs/stop', async () => ({ stopped: stopRun() }));
  app.get('/api/runs', async () => repo.listRuns());

  app.get('/api/logs/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (l: LogLine) => reply.raw.write(`data: ${JSON.stringify(l)}\n\n`);
    for (const l of recentLogs.slice(-200)) send(l);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    logBus.on('line', send);
    req.raw.on('close', () => {
      clearInterval(ping);
      logBus.off('line', send);
    });
  });

  if (opts.staticDir) {
    // production (npm start): the built dashboard on the same port; SPA fallback for non-API paths.
    // A tiny handler instead of @fastify/static (fewer deps; only one folder of built files to serve).
    const root = path.resolve(opts.staticDir);
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      const rel = decodeURIComponent(req.url.split('?')[0]!).replace(/^\/+/, '');
      let file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return reply.type(type).header('cache-control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable').send(fs.createReadStream(file));
    });
  }

  return app;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Applying is disabled while the site is known to be logged out (unknown = let the adapter find out). */
export function assertCanApply(site: string): void {
  if (getSession(site).state === 'logged_out') {
    throw new ServiceError(409, `אין חיבור ל-${site} — יש להתחבר בחלון ההתחברות (או npm run login -- ${site}) ואז "בדוק שוב" / Not logged in to ${site}: run npm run login -- ${site}, then "Re-check"`);
  }
}
