import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { log, logBus, recentLogs, type LogLine } from '../log.js';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { SITES } from '../sites/registry.js';
import { JOB_STATUSES } from '../sites/types.js';
import { getActiveRun, startRun, startTask, stopRun } from '../pipeline/runner.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { listLocalModels } from '../llm/ollama.js';
import { prepareJobs, ServiceError } from '../apply/service.js';
import { registerApplyRoutes } from './apply-routes.js';
import fastifyStatic from '@fastify/static';
import { allSessions, checkDrushimSession, getSession } from '../browser/site-session.js';

export function buildApp(db: DB, opts: { staticDir?: string } = {}) {
  // No per-request logging (the dashboard polls); errors are logged below.
  const app = Fastify({ logger: false });
  const repo = new Repo(db);

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof z.ZodError ? 400 : err instanceof ServiceError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) log.error({ url: req.url, err: err instanceof Error ? err.message : String(err) }, 'http error');
    reply.status(status).send({ error: err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err) });
  });

  app.get('/api/status', async () => {
    const prefs = loadPrefs();
    let ollama: { ok: boolean; models: string[] } = { ok: false, models: [] };
    try {
      ollama = { ok: true, models: await listLocalModels() };
    } catch {
      /* offline */
    }
    return {
      dryRun: config.DRY_RUN,
      activeRun: getActiveRun(),
      today: { submitted: repo.submittedToday() },
      limits: effectiveLimits(prefs),
      counts: repo.statusCounts(),
      models: { analyze: config.OLLAMA_MODEL_ANALYZE, write: config.OLLAMA_MODEL_WRITE },
      ollama: {
        ...ollama,
        analyzeAvailable: ollama.models.some((m) => m === config.OLLAMA_MODEL_ANALYZE || m === `${config.OLLAMA_MODEL_ANALYZE}:latest`),
      },
      sites: SITES,
      sessions: allSessions(),
      pendingQuestions: (db.prepare("SELECT COUNT(*) AS n FROM answers WHERE status = 'pending'").get() as { n: number }).n,
    };
  });

  const JobsQuery = z.object({
    site: z.string().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  });
  app.get('/api/jobs', async (req) => repo.listJobs(JobsQuery.parse(req.query)));

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

  registerApplyRoutes(app, db);

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
    // production (npm start): the built dashboard on the same port; SPA fallback for non-API paths
    void app.register(fastifyStatic, { root: opts.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

/** Applying is disabled while the site is known to be logged out (unknown = let the adapter find out). */
export function assertCanApply(site: string): void {
  if (getSession(site).state === 'logged_out') {
    throw new ServiceError(409, `לא מחובר ל-${site} — הרץ npm run login -- ${site} ואז "בדוק שוב" / Not logged in to ${site}: run npm run login -- ${site}, then "Re-check"`);
  }
}
