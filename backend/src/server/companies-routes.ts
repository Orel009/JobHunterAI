/**
 * Companies screen: your target companies (data/companies.yaml). Adding one detects its ATS from a careers URL or a job
 * link (or by asking the ATS APIs with the company's name) and reads its job list once to show the totals; a company on
 * your excluded list is refused. Supported ones (Greenhouse, Comeet, SmartRecruiters) are read by the companies run.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { llmGate } from './llm-gate.js';
import type { DB } from '../db/index.js';
import { ServiceError } from '../apply/service.js';
import { detectAts, nameVariants, type Detected } from '../companies/detect.js';
import { fetchCompanyJobs, keepCompanyJob } from '../companies/fetch.js';
import { addCompany, atsStatus, companyId, isSupported, loadCompanies, removeCompany, saveCompanies, updateCompany, type Company } from '../companies/store.js';
import { companiesProgress, recordCheck, startCompaniesRun } from '../companies/run.js';
import { loadPrefs } from '../core/prefs.js';
import { excludedCompanyMatch } from '../core/prefilter.js';
import { isPaused, pauseSite } from '../core/site-pause.js';

/** The excluded-companies entry a company matches (by the name you gave, its domain name, or the ATS's name), or null. */
export function excludedCompany(names: string[]): { name: string; match: string } | null {
  const ex = loadPrefs().filters.excludeCompanies;
  for (const n of names.filter(Boolean)) {
    const m = excludedCompanyMatch(n, ex);
    if (m) return { name: n, match: m };
  }
  return null;
}

export function registerCompaniesRoutes(app: FastifyInstance, db: DB): void {
  const view = () => loadCompanies().map((c) => ({ ...c, comeetToken: c.comeetToken ? { readAt: c.comeetToken.readAt } : null, supported: isSupported(c), status: atsStatus(c), paused: isPaused(c.ats) }));
  const state = () => ({ companies: view(), progress: companiesProgress() });

  /** one read of the list for the totals; refused afterwards when the ATS's own company name is excluded */
  const preview = async (c: Company) => {
    if (!isSupported(c) || isPaused(c.ats)) return null;
    const f = await fetchCompanyJobs(c);
    const ex = excludedCompany([f.jobs[0]?.company ?? '']);
    if (ex) {
      removeCompany(c.id);
      throw new ServiceError(409, `not added: "${ex.name}" is on your excluded companies (matches "${ex.match}")`);
    }
    const kept = f.error || f.blocked ? null : f.jobs.filter((j) => keepCompanyJob(j, loadPrefs())).length;
    recordCheck(c, f, kept);
    if (f.blocked) pauseSite(c.ats, f.blocked); // a refusal pauses that ATS for 48 hours, as on every site
    return { total: f.total, israel: f.israel, kept, error: f.blocked ?? f.error };
  };
  const detected = (d: Detected) => ({ ats: d.ats, board: d.board, supported: d.supported, how: d.how, evidence: d.evidence });

  app.get('/api/companies', async () => state());

  /** A careers URL or a job link → the ATS (the address, the page, then the ATS APIs by name), then the totals. */
  app.post('/api/companies', async (req) => {
    const { url, name } = z.object({ url: z.string().trim().min(8).max(2000), name: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const domainName = nameVariants('', url)[0] ?? '';
    const ex = excludedCompany([name ?? '', domainName]);
    if (ex) throw new ServiceError(409, `not added: "${ex.name}" is on your excluded companies (matches "${ex.match}")`);
    const d = await detectAts(url, fetch, name ?? domainName);
    const c = addCompany(d, url, name ?? '');
    return { detected: detected(d), preview: await preview(c), ...state() };
  });

  /** Detect again (e.g. companies added before the ATS APIs were asked by name). */
  app.post<{ Params: { id: string } }>('/api/companies/:id/detect', async (req) => {
    const list = loadCompanies();
    const c = list.find((x) => x.id === req.params.id);
    if (!c) throw new ServiceError(404, 'no such company');
    const d = await detectAts(c.url, fetch, c.name);
    const next: Company = { ...c, id: companyId(d.ats, d.board, c.url), ats: d.ats, board: d.board, slug: d.slug ?? null, enabled: d.supported && (c.enabled || c.ats === 'unknown'), comeetToken: d.board === c.board ? c.comeetToken : null };
    if (next.id !== c.id && list.some((x) => x.id === next.id)) {
      removeCompany(c.id); // the same company is already listed under its detected ATS
      return { detected: detected(d), preview: null, ...state() };
    }
    saveCompanies(list.map((x) => (x.id === c.id ? next : x)));
    return { detected: detected(d), preview: await preview(next), ...state() };
  });

  app.patch<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    const patch = z.object({ enabled: z.boolean().optional(), name: z.string().trim().max(120).optional() }).parse(req.body ?? {});
    const c = loadCompanies().find((x) => x.id === req.params.id);
    if (!c) throw new ServiceError(404, 'no such company');
    if (patch.enabled && !isSupported(c)) throw new ServiceError(409, `${atsStatus(c)} — it cannot be turned on`);
    updateCompany(c.id, patch);
    return state();
  });

  app.delete<{ Params: { id: string } }>('/api/companies/:id', async (req) => {
    if (!removeCompany(req.params.id)) throw new ServiceError(404, 'no such company');
    return state();
  });

  /** The companies-only run: read the lists → prefilter → experience cap → score → prepare the Greenhouse answers. */
  app.post('/api/companies/fetch', async (req, reply) => {
    if (!loadCompanies().some((c) => c.enabled && isSupported(c))) return reply.status(409).send({ error: 'no company is turned on (Companies screen)' });
    if (!(await llmGate(req.body, reply))) return reply;
    try {
      return { runId: startCompaniesRun(db) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });
  /** Score only: what is waiting (no list is read). */
  app.post('/api/companies/score', async (req, reply) => {
    if (!(await llmGate(req.body, reply))) return reply;
    try {
      return { runId: startCompaniesRun(db, { fetch: false }) };
    } catch (e) {
      return reply.status(409).send({ error: (e as Error).message });
    }
  });
}
