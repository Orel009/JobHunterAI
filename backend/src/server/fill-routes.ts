/**
 * JobHunter Fill (Chrome extension, in your regular Chrome) ↔ the local backend.
 *   /api/fill/*  — only with the per-install token (X-JobHunter-Token), and never from a web page: a request carrying a
 *                  web origin (http/https) is refused, whatever its token. The extension's background worker sends no
 *                  web origin (chrome-extension://…), and the page itself never sees the token or the data.
 *   /api/extension — the dashboard's Settings card: the token to paste into the extension's options, and a new one.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { ServiceError } from '../apply/service.js';
import { extensionToken, regenerateExtensionToken, tokenOk } from '../extension/token.js';
import { fillData, markAppliedByHand, matchJob } from '../extension/fill.js';
import { ROOT_DIR } from '../config.js';
import { isIndeedHost } from '../alerts/assisted.js';
import { isLinkedInHost } from '../linkedin/parse.js';
import path from 'node:path';

/** A browser page's request (any http/https origin) — the dashboard is same-origin and sends none for GET. */
const fromWebPage = (req: FastifyRequest) => /^https?:\/\//i.test(String(req.headers.origin ?? ''));

export function registerFillRoutes(app: FastifyInstance, db: DB): void {
  const repo = new Repo(db);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/fill/')) return;
    if (fromWebPage(req)) return reply.status(403).send({ error: 'not from a web page' });
    if (!tokenOk(req.headers['x-jobhunter-token'] as string | undefined)) return reply.status(401).send({ error: 'missing or wrong extension token (Settings → JobHunter Fill)' });
  });

  app.get('/api/fill/ping', async () => ({ ok: true }));

  /** The JobHunter job of the page in your browser (null = not one of yours; contact details and the bank still fill). */
  app.get('/api/fill/match', async (req) => {
    const { url } = z.object({ url: z.string().min(8).max(4000) }).parse(req.query);
    // LinkedIn and Indeed are manual only: the extension never fills there (it refuses too; this is the second lock)
    if (isLinkedInHost(url) || isIndeedHost(url)) throw new ServiceError(403, 'LinkedIn/Indeed: manual only, use the copy panel');
    const job = matchJob(db, url);
    return { job: job ? { id: job.id, title: job.title, company: job.company, site: job.site, status: job.status } : null };
  });

  app.get('/api/fill/data', async (req) => {
    const { jobId } = z.object({ jobId: z.string().max(80).optional() }).parse(req.query);
    const job = jobId ? repo.getJob(jobId) : null;
    if (jobId && !job) throw new ServiceError(404, 'no such job');
    return fillData(db, job);
  });

  app.post<{ Params: { id: string } }>('/api/fill/jobs/:id/applied', async (req) => {
    const job = repo.getJob(req.params.id);
    if (!job) throw new ServiceError(404, 'no such job');
    return { ok: true, ...markAppliedByHand(db, job) };
  });

  // ---------- dashboard (Settings) ----------
  app.get('/api/extension', async (req, reply) => {
    if (fromWebPage(req) && !String(req.headers.origin).startsWith(`http://127.0.0.1:`) && !String(req.headers.origin).startsWith('http://localhost:')) return reply.status(403).send({ error: 'dashboard only' });
    return { token: extensionToken(), folder: path.join(ROOT_DIR, 'extension') };
  });
  app.post('/api/extension/token', async (req, reply) => {
    if (fromWebPage(req) && !String(req.headers.origin).startsWith(`http://127.0.0.1:`) && !String(req.headers.origin).startsWith('http://localhost:')) return reply.status(403).send({ error: 'dashboard only' });
    return { token: regenerateExtensionToken() };
  });
}
