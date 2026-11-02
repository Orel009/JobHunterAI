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
import { coverLetterDraft, fillData, markAppliedByHand, matchJob } from '../extension/fill.js';
import { classifyLabels, planForm } from '../extension/labels.js';
import { extensionSettings, saveExtensionSettings } from '../extension/settings.js';
import { ROOT_DIR } from '../config.js';
import { isIndeedHost } from '../alerts/assisted.js';
import { isLinkedInHost } from '../linkedin/parse.js';
import { llmReachable } from '../llm/reachable.js';
import { fetchJobContext } from '../extension/job-context.js';
import { AnswersBank, type BankType } from '../apply/bank.js';
import { log } from '../log.js';
import path from 'node:path';

/** A browser page's request (any http/https origin) — the dashboard is same-origin and sends none for GET. */
const fromWebPage = (req: FastifyRequest) => /^https?:\/\//i.test(String(req.headers.origin ?? ''));

/** a string cut to n characters (a long title or label is shortened, never refused) */
const cut = (n: number) =>
  z
    .string()
    .default('')
    .transform((s) => s.slice(0, n));

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
    const { jobId, lang } = z.object({ jobId: z.string().max(80).optional(), lang: z.enum(['he', 'en']).optional() }).parse(req.query);
    const job = jobId ? repo.getJob(jobId) : null;
    if (jobId && !job) throw new ServiceError(404, 'no such job');
    return fillData(db, job, lang);
  });

  /** Labels the extension's dictionary does not know → a field type (the model picks a type, never a value; cached). */
  app.post('/api/fill/classify', async (req) => {
    const { labels } = z.object({ labels: z.array(z.string().max(300)).max(60) }).parse(req.body ?? {});
    try {
      return { types: await classifyLabels(labels) };
    } catch (e) {
      log.warn({ labels: labels.length, err: e instanceof Error ? e.message : String(e) }, 'extension: labels not classified');
      throw e;
    }
  });

  /**
   * The form planner: the page's fields (and the job) → a kind per field (a profile key, a draft, or unknown). No values.
   * Cached per site + form; a failure comes back as the reason for the overlay.
   */
  app.post('/api/fill/plan', async (req) => {
    const S = (n: number) => z.string().max(n).default('');
    const b = z
      .object({
        url: z.string().max(4000),
        fields: z
          .array(z.object({ key: z.string().max(300), label: S(300), placeholder: S(300), name: S(200), type: S(40), options: z.array(z.string().max(200)).max(80).default([]), required: z.boolean().default(false), near: S(400) }))
          .max(120),
        job: z.object({ title: S(300), company: S(200), text: S(8000) }).default({ title: '', company: '', text: '' }),
      })
      .parse(req.body ?? {});
    const host = (() => {
      try {
        return new URL(b.url).hostname;
      } catch {
        return 'unknown';
      }
    })();
    const t0 = Date.now();
    try {
      const r = await planForm(host, b.fields, b.job);
      log.info({ host, fields: b.fields.length, cached: r.cached, ms: Date.now() - t0, drafts: Object.values(r.plan).filter((k) => k.startsWith('draft:')).length }, 'extension: form planned');
      return { ...r, error: null };
    } catch (e) {
      const reach = await llmReachable();
      const error = reach.ok ? `the model failed: ${e instanceof Error ? e.message : String(e)}` : `${reach.reason}: start it (JobHunter → the LLM badge → Start Ollama), then fill again`;
      log.warn({ host, fields: b.fields.length, err: error }, 'extension: form not planned');
      return { plan: {}, cached: false, signature: null, error };
    }
  });

  /**
   * The job ad for an application page that does not show it: the ATS's public job endpoint (Workable, Greenhouse,
   * SmartRecruiters, Comeet) or the same address without "/apply". Plain GETs from JobHunter; never LinkedIn / Indeed.
   */
  app.post('/api/fill/job-context', async (req) => {
    const { url } = z.object({ url: z.string().max(4000) }).parse(req.body ?? {});
    const t0 = Date.now();
    const r = await fetchJobContext(url);
    log.info({ url: url.slice(0, 200), ok: r.ok, source: r.ok ? r.context.source : null, chars: r.ok ? r.context.text.length : 0, error: r.ok ? null : r.error, ms: Date.now() - t0 }, 'extension: job context');
    return r.ok ? { ok: true, ...r.context, error: null } : { ok: false, title: '', company: '', text: '', source: null, error: r.error };
  });

  /** Questions a form asked that have no answer on file (yes / no, a choice): into your answers bank as pending, once. */
  app.post('/api/fill/pending', async (req) => {
    const { questions } = z
      .object({ questions: z.array(z.object({ question: z.string().trim().min(4).max(500), type: z.enum(['text', 'yes_no', 'choice', 'number']).default('text'), options: z.array(z.string().max(200)).max(40).optional() })).max(20) })
      .parse(req.body ?? {});
    const bank = new AnswersBank(db);
    const before = new Set(bank.list().map((e) => e.id));
    const entries = questions.map((q) => bank.addPending(q.question, q.type as BankType, q.options ?? null));
    const added = entries.filter((e) => !before.has(e.id)).length;
    if (added) log.info({ added, questions: entries.filter((e) => !before.has(e.id)).map((e) => e.question) }, 'extension: questions added to the answers bank (pending)');
    return { added, pending: entries.filter((e) => e.status === 'pending').length };
  });

  /** What one fill did (field labels, kinds, draft outcomes and reasons; no values typed into the page), for the log. */
  app.post('/api/fill/report', async (req) => {
    const b = z
      .object({
        url: cut(500),
        linked: z.boolean().default(false),
        jobContext: cut(120),
        fields: z.array(z.object({ label: cut(120), type: cut(30), required: z.boolean().default(false), rule: z.string().nullable().default(null), planned: z.string().nullable().default(null) })).max(150).default([]),
        drafts: z.array(z.object({ label: cut(120), kind: cut(10), ok: z.boolean(), error: z.string().nullable().default(null), ms: z.number().default(0) })).max(20).default([]),
        problems: z.array(cut(300)).max(20).default([]),
        questions: z.array(cut(300)).max(20).default([]),
        result: z.object({ filled: z.number(), drafts: z.number(), needYou: z.number(), pending: z.array(cut(300)).max(60).default([]), notes: z.array(cut(400)).max(30).default([]) }).nullable().default(null),
      })
      .parse(req.body ?? {});
    const host = (() => {
      try {
        return new URL(b.url).hostname;
      } catch {
        return 'unknown';
      }
    })();
    log.info({ host, linked: b.linked, jobContext: b.jobContext, fields: b.fields, drafts: b.drafts, problems: b.problems, questions: b.questions, result: b.result }, 'extension: fill report');
    return { ok: true };
  });

  /** A cover letter / message / bio: an AI draft from your profile facts, for you to review on the form. */
  app.post('/api/fill/draft', async (req) => {
    const b = z
      .object({
        jobId: z.string().max(80).optional(),
        // a long page title is cut, never a reason to refuse the draft
        title: cut(300),
        company: cut(200),
        label: cut(300),
        lang: z.enum(['he', 'en']).default('en'),
        /** cover: a cover letter / message / note; bio: about you */
        kind: z.enum(['cover', 'bio']).default('cover'),
        /** the job ad as the page shows it (a page JobHunter does not know) */
        jobText: cut(8000),
      })
      .parse(req.body ?? {});
    if (!extensionSettings().fillCoverLetters) throw new ServiceError(409, 'cover letters are off (Settings → JobHunter Fill)');
    const job = b.jobId ? repo.getJob(b.jobId) : null;
    const t0 = Date.now();
    // the model not there: said in the overlay ("no draft: …"), not an error deep in the call
    const reach = await llmReachable();
    const d = reach.ok
      ? await coverLetterDraft(db, { job, title: b.title, company: b.company, label: b.label, lang: b.lang, kind: b.kind, pageText: b.jobText }).catch((e: unknown) => ({
          text: null,
          flaggedClaims: [],
          usedFactIds: [],
          error: `the model failed: ${e instanceof Error ? e.message : String(e)}`,
          context: null,
        }))
      : { text: null, flaggedClaims: [], usedFactIds: [], error: `${reach.reason}: start it (JobHunter → the LLM badge → Start Ollama), then fill again`, context: null };
    log.info({ kind: b.kind, job: job ? `${job.title} — ${job.company}` : `(not linked) ${b.title} — ${b.company}`, context: d.context, ms: Date.now() - t0, ok: !!d.text, error: d.error, flaggedClaims: d.flaggedClaims.length }, 'extension: draft');
    return d;
  });

  app.post<{ Params: { id: string } }>('/api/fill/jobs/:id/applied', async (req) => {
    const job = repo.getJob(req.params.id);
    if (!job) throw new ServiceError(404, 'no such job');
    return { ok: true, ...markAppliedByHand(db, job) };
  });

  // ---------- dashboard (Settings) ----------
  app.get('/api/extension', async (req, reply) => {
    if (fromWebPage(req) && !String(req.headers.origin).startsWith(`http://127.0.0.1:`) && !String(req.headers.origin).startsWith('http://localhost:')) return reply.status(403).send({ error: 'dashboard only' });
    return { token: extensionToken(), folder: path.join(ROOT_DIR, 'extension'), settings: extensionSettings() };
  });
  app.put('/api/extension/settings', async (req, reply) => {
    if (fromWebPage(req) && !String(req.headers.origin).startsWith(`http://127.0.0.1:`) && !String(req.headers.origin).startsWith('http://localhost:')) return reply.status(403).send({ error: 'dashboard only' });
    const patch = z.object({ fillCoverLetters: z.boolean().optional(), styleSample: z.string().max(4000).optional(), draftOptionalFields: z.boolean().optional() }).parse(req.body ?? {});
    return saveExtensionSettings(patch);
  });
  app.post('/api/extension/token', async (req, reply) => {
    if (fromWebPage(req) && !String(req.headers.origin).startsWith(`http://127.0.0.1:`) && !String(req.headers.origin).startsWith('http://localhost:')) return reply.status(403).send({ error: 'dashboard only' });
    return { token: regenerateExtensionToken() };
  });
}
