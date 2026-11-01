import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { log, logBus, recentLogs, type LogLine } from '../log.js';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { SITES } from '../sites/registry.js';
import { JOB_STATUSES } from '../sites/types.js';
import { pauseExpired, pausedText, sitePauses } from '../core/site-pause.js';
import { resumeSiteNow } from '../pipeline/site-resume.js';
import { getActiveRun, refilterExisting, startRun, startTask, stopRun, syncSalaries } from '../pipeline/runner.js';
import { scorePending } from '../pipeline/score-pending.js';
import { effectiveLimits, loadPrefs } from '../core/prefs.js';
import { byRank, rankStoredJob } from '../core/rank.js';
import { marketStats } from '../core/market.js';
import { listLocalModels } from '../llm/llm.js';
import { taskConfig } from '../llm/settings.js';
import { usageReport } from '../llm/usage.js';
import { registerLlmRoutes } from './llm-routes.js';
import { loginWindowOpen, registerOnboardingRoutes } from './onboarding-routes.js';
import { registerLinkedInRoutes } from './linkedin-routes.js';
import { registerHistoryRoutes } from './history-routes.js';
import { autoSubmitSettings, effectiveMinRank, pauseAutoSubmit, saveAutoSubmitSettings } from '../apply/auto-submit.js';
import { huntProgress, huntRunning, recentHunts, runHunt, sendingMode } from '../pipeline/hunt.js';
import { inQuietHours, isHhmm, nextRun, runnableTimes, saveScheduleSettings, scheduleSettings } from '../pipeline/schedule.js';
import { emailAlertsEnabled, enabledSources, linkedInEnabled } from '../linkedin/settings.js';
import { batchProgress, prepareJobs, recoverStuckApprovals, ServiceError } from '../apply/service.js';
import { registerApplyRoutes } from './apply-routes.js';
import { registerCompaniesRoutes } from './companies-routes.js';
import { isSupported, loadCompanies, seedCompanies } from '../companies/store.js';
import { registerCvRoutes, registerEditorRoutes } from './editor-routes.js';
import fs from 'node:fs';
import path from 'node:path';
import { allSessions, checkDrushimSession, checkSiteSession, getSession, onSessionValid } from '../browser/site-session.js';

const OFF_FIELD = /^(seniority|excluded title|no include keyword|role type disabled|excluded company)/;

export function buildApp(db: DB, opts: { staticDir?: string } = {}) {
  // No per-request logging (the dashboard polls); errors are logged below.
  const app = Fastify({ logger: false });
  const repo = new Repo(db);
  syncSalaries(repo); // posted salary of jobs stored before this version (or whose text changed)
  seedCompanies(); // an empty data/companies.yaml the first time (never filled in for you)
  // applications left "approved" by a run that never finished (no run is active at startup): back to review, or blocked
  // when the send may have gone out
  const stuck = recoverStuckApprovals(db);
  if (stuck.length) log.warn({ applications: stuck }, 'approved applications that were never sent: recovered');
  // one job per company + title within the window, on any site — also for jobs stored before this rule existed
  const dups = repo.dedupeExisting(config.DEDUPE_WINDOW_DAYS);
  if (dups.length) log.info({ jobs: dups.length, examples: dups.slice(0, 5) }, 'duplicates of the same company + title marked skipped_duplicate (open applications closed)');
  // a valid session again → jobs that failed only on "not logged in" go back to the queue
  const requeue = (site: string) => {
    const n = repo.requeueLoginFailures(site);
    if (n) log.info({ site, jobs: n }, 'login valid again — jobs that failed on "not logged in" are back in the queue');
  };
  onSessionValid(requeue);
  if (getSession('drushim').state === 'logged_in') requeue('drushim'); // checked at startup, before this listener

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
      /** the LinkedIn source of the email job alerts is on */
      linkedin: { enabled: linkedInEnabled() },
      /** optional email job alerts (LinkedIn, Indeed): the assisted screen and the fetch button exist only while on */
      emailAlerts: { enabled: emailAlertsEnabled(), sources: enabledSources() },
      /** target companies (Companies screen): how many are listed / read on Run & send (their jobs: assisted panel) */
      companies: { listed: loadCompanies().length, enabled: loadCompanies().filter((c) => c.enabled && isSupported(c)).length },
      /** jobs a site's send left for you to apply by hand (e.g. a JobKarov CAPTCHA): shown in the assisted panel */
      needsManual: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'needs_manual'").get() as { n: number }).n,
      /** paused sites (not loaded at all): reason, since, until (the resume check may run from then), expired */
      pauses: Object.fromEntries(Object.entries(sitePauses()).map(([k, v]) => [k, { ...v, expired: pauseExpired(v) }])),
      /** auto-submit (off by default): per-site toggles, the kill switch and the effective minimum rank */
      autoSubmit: { ...autoSubmitSettings(), minRankEffective: effectiveMinRank() },
      /** the latest hunt's summary, and the next in-app scheduled hunt (null = off) */
      lastHunt: recentHunts(db, 1)[0] ?? null,
      huntRunning: huntRunning(),
      /** Run & send: live progress of the running (or last) hunt, whether it can send, and what still runs */
      huntProgress: huntProgress(),
      sending: sendingMode('drushim'),
      stillRunning: stillRunning(),
      schedule: { enabled: scheduleSettings().enabled, next: scheduleSettings().enabled ? (nextRun(new Date(), scheduleSettings())?.toISOString() ?? null) : null },
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
  registerCompaniesRoutes(app, db);
  registerHistoryRoutes(app, db);

  // ---------- hunts and schedule ----------
  /** one full hunt in the background (the dashboard button, or a scheduled run handed to this running app) */
  app.post('/api/hunt', async (req, reply) => {
    const { trigger } = z.object({ trigger: z.enum(['manual', 'task']).default('manual') }).parse(req.body ?? {});
    if (huntRunning() || getActiveRun()) return reply.status(409).send({ error: 'a run is already active' });
    void runHunt(db, { trigger }).catch((e: unknown) => log.error({ err: e instanceof Error ? e.message : String(e) }, 'hunt failed'));
    return { started: true };
  });
  app.get('/api/hunts', async () => recentHunts(db, 20));

  const scheduleView = () => {
    const s = scheduleSettings();
    return { ...s, runnable: runnableTimes(s), inQuiet: s.times.filter((t) => inQuietHours(t, s.quietHours)), next: nextRun(new Date(), s)?.toISOString() ?? null };
  };
  app.get('/api/schedule', async () => scheduleView());
  app.put('/api/schedule', async (req) => {
    const hhmm = z.string().refine(isHhmm, 'HH:MM');
    const b = z
      .object({
        enabled: z.boolean().optional(),
        times: z.array(hhmm).max(12).optional(),
        days: z.array(z.number().int().min(0).max(6)).optional(),
        quietHours: z.object({ from: hhmm, to: hhmm }).optional(),
        toast: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    saveScheduleSettings(b);
    log.info(scheduleView(), 'schedule settings changed');
    return scheduleView();
  });

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
  app.post('/api/session/check', async (req, reply) => {
    const { site } = z.object({ site: z.enum(['drushim', 'jobmaster', 'jobnet', 'jobkarov', 'alljobs']).default('drushim') }).parse(req.body ?? {});
    const paused = pausedText(site, SITES.find((s) => s.id === site)?.displayName ?? site);
    if (paused) return reply.status(409).send({ error: `${paused} — no session checks while paused` });
    try {
      return { runId: startTask(db, site, 'session_check', async () => void (site === 'drushim' ? await checkDrushimSession() : await checkSiteSession(site))) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });

  /** Settings → Resume: one session check; the site resumes only if it serves its real page (a block re-pauses it). */
  app.post<{ Params: { site: string } }>('/api/sites/:site/resume', async (req, reply) => {
    const site = req.params.site;
    if (!SITES.some((s) => s.id === site)) return reply.status(404).send({ error: `no such site: ${site}` });
    try {
      return await resumeSiteNow(db, site);
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
/** what is still working (empty = safe to close JobHunter and shut down) */
export function stillRunning(): string[] {
  const out: string[] = [];
  const run = getActiveRun();
  if (run) out.push(`run #${run.id} ${run.site}/${run.kind}: ${run.stage}`);
  if (huntRunning()) out.push('Run & send');
  const b = batchProgress();
  if (b && !b.finished) out.push(`batch approval ${b.done}/${b.total}`);
  if (loginWindowOpen()) out.push('the login window is open — close it when you are done logging in');
  return out;
}

export function assertCanApply(site: string): void {
  if (getSession(site).state === 'logged_out') {
    throw new ServiceError(409, `אין חיבור ל-${site} — יש להתחבר בחלון ההתחברות (או npm run login -- ${site}) ואז "בדוק שוב" / Not logged in to ${site}: run npm run login -- ${site}, then "Re-check"`);
  }
}
