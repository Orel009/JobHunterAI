/**
 * Companies screen: your target companies (data/companies.yaml). Adding one detects its ATS from a careers URL or a job
 * link and reads its job list once to show the totals; supported ones (Greenhouse, Comeet) are read on every Run & send.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { ServiceError } from '../apply/service.js';
import { detectAts } from '../companies/detect.js';
import { fetchCompanyJobs, keepCompanyJob } from '../companies/fetch.js';
import { addCompany, atsStatus, isSupported, loadCompanies, removeCompany, updateCompany } from '../companies/store.js';
import { recordCheck, startCompaniesRun } from '../companies/run.js';
import { loadPrefs } from '../core/prefs.js';
import { isPaused, pauseSite } from '../core/site-pause.js';

export function registerCompaniesRoutes(app: FastifyInstance, db: DB): void {
  const view = () => loadCompanies().map((c) => ({ ...c, comeetToken: c.comeetToken ? { readAt: c.comeetToken.readAt } : null, supported: isSupported(c), status: atsStatus(c), paused: isPaused(c.ats) }));

  app.get('/api/companies', async () => ({ companies: view() }));

  /** A careers URL or a job link → the ATS, then one read of its list for the totals. */
  app.post('/api/companies', async (req) => {
    const { url, name } = z.object({ url: z.string().trim().min(8).max(2000), name: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const d = await detectAts(url);
    const c = addCompany(d, url, name ?? '');
    let preview: { total: number | null; israel: number | null; kept: number | null; error: string | null } | null = null;
    if (isSupported(c) && !isPaused(c.ats)) {
      const f = await fetchCompanyJobs(c);
      const kept = f.error || f.blocked ? null : f.jobs.filter((j) => keepCompanyJob(j, loadPrefs())).length;
      recordCheck(c, f, kept);
      if (f.blocked) pauseSite(c.ats, f.blocked); // a refusal pauses that ATS for 48 hours, as on every site
      preview = { total: f.total, israel: f.israel, kept, error: f.blocked ?? f.error };
    }
    return { detected: { ats: d.ats, board: d.board, supported: d.supported, how: d.how, evidence: d.evidence }, preview, companies: view() };
  });

  app.patch<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    const patch = z.object({ enabled: z.boolean().optional(), name: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const c = loadCompanies().find((x) => x.id === req.params.id);
    if (!c) throw new ServiceError(404, 'no such company');
    if (patch.enabled && !isSupported(c)) throw new ServiceError(409, `${atsStatus(c)} — it cannot be turned on`);
    updateCompany(c.id, patch);
    return { companies: view() };
  });

  app.delete<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    if (!removeCompany(req.params.id)) throw new ServiceError(404, 'no such company');
    return { companies: view() };
  });

  /** Read every enabled company's list now (the same step Run & send runs). */
  app.post('/api/companies/fetch', async (_req, reply) => {
    try {
      return { runId: startCompaniesRun(db) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });
}
