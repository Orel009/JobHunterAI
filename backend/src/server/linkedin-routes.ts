/**
 * Email job alerts — LinkedIn, Indeed (optional, off by default) — and the assisted-apply screen.
 * Settings work while off (to turn it on); everything else answers 409 while off, so nothing touches IMAP.
 * LinkedIn and Indeed are only ever opened in the user's own default browser.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { log } from '../log.js';
import { ServiceError, prepareJobs } from '../apply/service.js';
import { getActiveRun, startRun, syncSalaries } from '../pipeline/runner.js';
import { startLinkedInRun } from '../pipeline/linkedin-run.js';
import { emailAlertsEnabled, publicLinkedInSettings, saveEmailAlertSettings, setImapConfig } from '../linkedin/settings.js';
import { isAssistedSite, SITE_LABEL } from '../alerts/assisted.js';
import { LinkedInDisabledError, testImap } from '../linkedin/imap.js';
import { applyHelper, localCvFile } from '../linkedin/helper.js';
import { openInDefaultBrowser, revealFile } from '../linkedin/open.js';
import { routeExternalApply } from '../linkedin/external.js';
import { contentHash } from '../core/job.js';

const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  windowDays: z.number().int().min(1).max(90).optional(),
  mailbox: z.string().min(1).max(200).optional(),
  sources: z.object({ linkedin: z.boolean().optional(), indeed: z.boolean().optional() }).optional(),
  host: z.string().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().max(200).optional(),
  /** write-only; null clears it */
  password: z.string().max(200).nullable().optional(),
});

export function registerLinkedInRoutes(app: FastifyInstance, db: DB): void {
  const repo = new Repo(db);
  const requireOn = () => {
    if (!emailAlertsEnabled()) throw new ServiceError(409, new LinkedInDisabledError().message);
  };
  const linkedInJob = (id: string) => {
    requireOn();
    const job = repo.getJob(id);
    if (!job || !isAssistedSite(job.site)) throw new ServiceError(404, 'no such LinkedIn / Indeed job');
    return job;
  };

  app.get('/api/linkedin/settings', async () => publicLinkedInSettings());

  app.put('/api/linkedin/settings', async (req) => {
    const b = SettingsBody.parse(req.body ?? {});
    const { enabled, windowDays, mailbox, sources, ...imap } = b;
    if (Object.keys(imap).length) setImapConfig(imap);
    saveEmailAlertSettings({ ...(enabled !== undefined ? { enabled } : {}), ...(windowDays ? { windowDays } : {}), ...(mailbox ? { mailbox } : {}), ...(sources ? { sources } : {}) });
    if (enabled !== undefined || sources) log.info({ enabled, sources }, 'email job alerts settings changed');
    return publicLinkedInSettings();
  });

  app.post('/api/linkedin/test', async (_req, reply) => {
    requireOn();
    try {
      return { ok: true, ...(await testImap()) };
    } catch (e) {
      return reply.status(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/linkedin/fetch', async (_req, reply) => {
    requireOn();
    try {
      return { runId: startLinkedInRun(db, 'fetch') };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/linkedin/jobs/:id/helper', async (req) => {
    const job = linkedInJob(req.params.id);
    // every link of this job: its own and those of the same job from other sources (LinkedIn, Indeed, Drushim…)
    return { ...applyHelper(db, job, repo.getScore(job.id)?.matchedSkills ?? []), site: job.site, siteLabel: SITE_LABEL[job.site as 'linkedin'], links: repo.sourceLinks(job.id) };
  });

  /** Opens the job in the user's DEFAULT browser (never the automated one). */
  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/open', async (req) => {
    const job = linkedInJob(req.params.id);
    openInDefaultBrowser(job.applyTarget || job.url);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/show-cv', async (req) => {
    const job = linkedInJob(req.params.id);
    const { lang } = applyHelper(db, job).cv;
    try {
      revealFile(localCvFile(lang));
    } catch {
      throw new ServiceError(404, `no ${lang === 'he' ? 'Hebrew' : 'English'} CV uploaded yet (Profile screen)`);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/applied', async (req) => {
    const job = linkedInJob(req.params.id);
    const at = nowIso();
    db.prepare("UPDATE jobs SET status = 'submitted_manual', status_reason = ?, applied_manually_at = ?, updated_at = ? WHERE id = ?").run(
      `applied by hand on ${SITE_LABEL[job.site as 'linkedin']} at ${at}`,
      at,
      at,
      job.id,
    );
    return { ok: true, appliedAt: at };
  });

  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/skip', async (req) => {
    const job = linkedInJob(req.params.id);
    repo.setStatus(job.id, 'skipped', 'skipped manually');
    return { ok: true };
  });

  /** The user pastes the full description → saved, then the job is scored again with it. */
  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/description', async (req) => {
    const job = linkedInJob(req.params.id);
    const { text } = z.object({ text: z.string().trim().min(20, 'paste the whole description').max(30_000) }).parse(req.body ?? {});
    const hash = contentHash({ ...job, descriptionText: text });
    db.prepare(
      // a new content hash makes the scorer pick it up again (jobsNeedingScore)
      'UPDATE jobs SET description_text = ?, details_fetched = 1, content_hash = ?, updated_at = ? WHERE id = ?',
    ).run(text, hash, nowIso(), job.id);
    syncSalaries(repo); // a pasted description may state the salary
    if (getActiveRun()) return { ok: true, note: 'saved — it is scored again on the next LinkedIn run (another run is active)' };
    return { ok: true, runId: startLinkedInRun(db, 'score'), note: 'saved — scoring again with the full description…' };
  });

  /** "Apply on company website" link: a supported site joins the automated flow, anything else goes to the review queue. */
  app.post<{ Params: { id: string } }>('/api/linkedin/jobs/:id/external', async (req) => {
    const job = linkedInJob(req.params.id);
    const { url } = z.object({ url: z.string().min(8).max(2000) }).parse(req.body ?? {});
    let route;
    try {
      route = routeExternalApply(db, job, url);
    } catch (e) {
      throw new ServiceError(400, (e as Error).message);
    }
    if (route.kind === 'site') {
      if (getActiveRun()) return { ...route, note: `added as a ${route.site} job — it is read and scored on the next ${route.site} run` };
      return { ...route, runId: startRun(db, route.site, 'enrich'), note: `added as a ${route.site} job — reading its page and scoring it, then use "apply" on the Jobs screen` };
    }
    if (getActiveRun()) {
      repo.setStatus(job.id, 'queued', 'waiting for the current run to finish');
      return { ...route, note: 'queued — click "Prepare queued" when the current run finishes' };
    }
    return { ...route, runId: prepareJobs(db, [job.id]), note: 'sent to the review queue with the company link' };
  });
}
