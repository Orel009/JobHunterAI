import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { loadPrefs } from '../core/prefs.js';
import { byRank, rankStoredJob } from '../core/rank.js';
import { AnswersBank } from '../apply/bank.js';
import { Applications, type AppStatus } from '../apply/plan.js';
import { approveApplication, approveBatch, batchBlock, batchProgress, editField, prepareJobs, refreshFromBank, rejectApplication, setCv } from '../apply/service.js';
import { candidateGender, listFacts, loadProfile, profilePath } from '../profile/facts.js';
import { assertCanApply } from './app.js';

const APP_STATUSES = ['needs_review', 'ready', 'approved', 'dry_run_ok', 'submitted', 'skipped', 'failed', 'blocked', 'rejected'] as const;
const BankBody = z.object({
  question: z.string().min(1),
  answer: z.string().nullable().optional(),
  type: z.enum(['text', 'yes_no', 'choice', 'number']).default('text'),
  options: z.array(z.string()).nullable().optional(),
});

export function registerApplyRoutes(app: FastifyInstance, db: DB) {
  const repo = new Repo(db);
  const apps = new Applications(db);
  const bank = new AnswersBank(db);

  const withJob = (a: ReturnType<Applications['get']>) => {
    if (!a) return null;
    const job = repo.getJob(a.jobId);
    const score = repo.getScore(a.jobId);
    const rank = job ? rankStoredJob(job, score, loadPrefs()) : rankStoredJob({ title: '', roleTypes: [], requiredYears: null, juniorText: null }, null, loadPrefs());
    return { ...a, job: job ? { ...job, raw: undefined } : null, score, rank, batchBlock: batchBlock(a) };
  };

  // ---------- applications ----------
  app.get('/api/applications', async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const statuses = q.status ? (q.status.split(',').filter((s) => (APP_STATUSES as readonly string[]).includes(s)) as AppStatus[]) : undefined;
    return apps
      .list(statuses)
      .map((a) => withJob(a)!)
      .sort(byRank);
  });

  app.get<{ Params: { id: string } }>('/api/applications/:id', async (req, reply) => {
    const a = withJob(apps.get(Number(req.params.id)));
    return a ?? reply.status(404).send({ error: 'not found' });
  });

  app.patch<{ Params: { id: string; key: string } }>('/api/applications/:id/fields/:key', async (req) => {
    const body = z.object({ value: z.string(), saveToBank: z.boolean().default(true) }).parse(req.body);
    return withJob(editField(db, Number(req.params.id), req.params.key, body.value, body.saveToBank));
  });

  app.put<{ Params: { id: string } }>('/api/applications/:id/cv', async (req) => {
    const body = z.object({ lang: z.enum(['he', 'en']) }).parse(req.body);
    return withJob(setCv(db, Number(req.params.id), body.lang));
  });

  app.post<{ Params: { id: string } }>('/api/applications/:id/approve', async (req) => {
    const a = apps.get(Number(req.params.id));
    if (a) assertCanApply(a.site || 'drushim');
    return approveApplication(db, Number(req.params.id));
  });

  // batch approval: sequential sends with normal pacing; stops on a CAPTCHA, a daily cap or a session problem
  app.post('/api/applications/approve-batch', async (req) => {
    const body = z.object({ ids: z.array(z.number().int()).min(1).max(200) }).parse(req.body);
    assertCanApply('drushim');
    return approveBatch(db, body.ids);
  });
  app.get('/api/applications/batch', async () => batchProgress());

  app.post<{ Params: { id: string } }>('/api/applications/:id/reject', async (req) => {
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    rejectApplication(db, Number(req.params.id), body.reason);
    return { ok: true };
  });

  app.post('/api/applications/prepare', async (req) => {
    const body = z.object({ jobIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const ids = body.jobIds?.length ? body.jobIds : repo.listJobs({ status: 'queued', limit: 500 }).items.map((j) => j.id);
    if (ids.length === 0) return { ok: true, note: 'nothing queued' };
    assertCanApply('drushim');
    return { ok: true, runId: prepareJobs(db, ids), count: ids.length };
  });

  // ---------- answers bank ----------
  app.get('/api/answers', async () => {
    const blocks = apps.pendingBlockCounts();
    return bank.list().map((e) => ({ ...e, blocks: blocks.get(e.normKey) ?? 0 }));
  });
  app.post('/api/answers', async (req) => {
    const b = BankBody.parse(req.body);
    const e = bank.upsert({ ...b, source: 'user' });
    refreshFromBank(db);
    return e;
  });
  app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const b = BankBody.partial().parse(req.body);
    const e = bank.update(Number(req.params.id), b);
    if (!e) return reply.status(404).send({ error: 'not found' });
    refreshFromBank(db);
    return e;
  });
  app.delete<{ Params: { id: string } }>('/api/answers/:id', async (req) => ({ ok: bank.delete(Number(req.params.id)) }));
  app.post('/api/answers/seed', async () => ({ seeded: bank.seed(loadPrefs(), candidateGender()), refreshed: refreshFromBank(db) }));

  // ---------- evidence ----------
  app.get<{ Params: { file: string } }>('/api/screenshots/:file', async (req, reply) => {
    const name = path.basename(req.params.file);
    if (!/^[\w.-]+\.(png|json)$/.test(name)) return reply.status(400).send({ error: 'bad file name' });
    const file = path.join(config.paths.screenshots, name);
    if (!fs.existsSync(file)) return reply.status(404).send({ error: 'not found' });
    return reply.type(name.endsWith('.png') ? 'image/png' : 'application/json').send(fs.createReadStream(file));
  });

  // ---------- profile ----------
  app.get('/api/profile/status', async () => {
    const draft = fs.existsSync(path.join(config.paths.profileDir, 'profile.draft.json'));
    try {
      const p = loadProfile();
      return { exists: !!p, valid: !!p, draftExists: draft, facts: p ? listFacts(p).length : 0, path: profilePath() };
    } catch (e) {
      return { exists: true, valid: false, draftExists: draft, error: (e as Error).message, path: profilePath() };
    }
  });
}
