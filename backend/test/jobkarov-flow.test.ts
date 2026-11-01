/**
 * JobKarov through the apply service, with the site module replaced by stand-ins: the CV by its stored file name,
 * a CAPTCHA answer → needs_manual (reason "captcha", the assisted panel, counted per session; never attempted),
 * "not current anymore" → skipped/expired, a company-site job found at prepare → the review queue with the link, the
 * employer's accepted answers → skipped_screening, and the batch rule (after two CAPTCHAs the rest of that site waits).
 * Also how the questions' answers are resolved: years rules, the answers bank only for levels, the salary rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-jk-flow';
  process.env.PREFERENCES_FILE = 'data/test-jk-flow/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { sent: [] as string[], openError: null as Error | null, outcome: { kind: 'submitted' } as Record<string, unknown> };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/jobkarov/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/jobkarov/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => {
    if (h.openError) throw h.openError;
    return {
      fields: [],
      cvs: [
        { code: '5550001', name: 'Test Person - Resume', checked: true },
        { code: '5550002', name: '- טסט טסטוב', checked: false },
      ],
      hasCoverLetter: false,
      extra: { preview: {} },
    };
  },
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
  submitPanel: async (_p: unknown, job: { externalId: string }) => {
    h.sent.push(job.externalId);
    return { outcome: h.outcome, confirmationText: (h.outcome.message as string) ?? 'JobKarov: sent (status 1)', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, nowIso, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { approveApplication, approveBatch, batchProgress, prepareJobs } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import { ApplyError } from '../src/sites/apply-error.js';
import { captchaCounts, doneReport } from '../src/pipeline/hunt.js';
import { buildApp } from '../src/server/app.js';
import { resolveField, type ResolveDeps } from '../src/apply/resolve.js';
import { questionKey } from '../src/apply/classify.js';
import type { BankEntry } from '../src/apply/bank.js';
import { ProfileSchema } from '../src/profile/schema.js';
import { optionIdFor, previewFields, rangeIdFor, type JkPreview } from '../src/sites/jobkarov/parse.js';
import { isPaused, pauseOf, sitePauses, unpauseSite } from '../src/core/site-pause.js';

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.mkdirSync(config.paths.screenshots, { recursive: true });
fs.writeFileSync(
  config.paths.preferences,
  'cv: { he: d-he.pdf, en: d-en.pdf }\njobkarov:\n  cv: { he: "- טסט טסטוב", en: "Test Person - Resume" }\nroleTypes:\n  - { id: fs, tier: 1, queries: [x], titleKeywords: [מפתח] }\n',
);

let db: DB;
let repo: Repo;
let apps: Applications;
let n = 0;
const addJob = (title = 'מפתח/ת Full Stack', company = `חברה ${++n}`) => {
  const j = toJob({ site: 'jobkarov', externalId: String(2700000 + n), company, title, location: 'נתניה', descriptionText: 'פיתוח מערכות ווב בצוות קטן', requirementsText: 'ניסיון: 1-2 שנים', url: `https://www.jobkarov.com/Search/Site/${2700000 + n}/1`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {} });
  repo.upsertJob(j);
  repo.setStatus(j.id, 'scored');
  return repo.getJob(j.id)!;
};
const prepared = async () => {
  const job = addJob();
  prepareJobs(db, [job.id]);
  await waitIdle();
  return { job, app: apps.latestForJob(job.id)! };
};

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.sent = [];
  h.openError = null;
  h.outcome = { kind: 'submitted' };
  for (const site of Object.keys(sitePauses())) unpauseSite(site);
});

describe('JobKarov through the apply service', () => {
  it('prepare: the CV by its stored file name (language rule), ready for review', async () => {
    const { app } = await prepared();
    expect(app.status).toBe('needs_review');
    expect(app.plan.cv).toMatchObject({ lang: 'he', cvName: '- טסט טסטוב' });
  });

  it('send answered with a CAPTCHA → needs_manual "captcha" (assisted panel), counted for the session; never attempted', async () => {
    const since = nowIso();
    const { job, app } = await prepared();
    h.outcome = { kind: 'needs_manual', reason: 'captcha', message: 'JobKarov asked for a CAPTCHA — not attempted; apply by hand' };
    approveApplication(db, app.id);
    await waitIdle();
    expect(h.sent).toEqual([job.externalId]);
    expect(repo.getJob(job.id)).toMatchObject({ status: 'needs_manual', statusReason: 'captcha' });
    expect(apps.get(app.id)).toMatchObject({ status: 'skipped', error: expect.stringMatching(/^needs_manual: captcha/) });
    const counts = captchaCounts(db, since);
    expect(counts).toEqual({ jobkarov: { captcha: 1, attempts: 1 } });
    const report = doneReport({ trigger: 'manual', startedAt: since, finishedAt: nowIso(), runs: [], found: 0, skipped: {}, readyForReview: 0, autoSubmitted: 0, failed: 0, loginNeeded: false, note: null, captchas: counts }, []);
    expect(report.join('\n')).toMatch(/JobKarov: CAPTCHA on 1 of 1 send attempt\(s\)/);
  });

  it('"not current anymore" at send → skipped / expired', async () => {
    const { job, app } = await prepared();
    h.outcome = { kind: 'expired', message: 'JobKarov: the employer marked the job as no longer current' };
    approveApplication(db, app.id);
    await waitIdle();
    expect(repo.getJob(job.id)).toMatchObject({ status: 'skipped', statusReason: expect.stringMatching(/^expired: /) });
    expect(apps.get(app.id)!.status).toBe('skipped');
  });

  it('prepare finds a company-site job → external with the link, in the review queue (no automation)', async () => {
    h.openError = new ApplyError('external_apply', 'https://careers.example.com/apply/9');
    const { job, app } = await prepared();
    expect(repo.getJob(job.id)).toMatchObject({ applyType: 'external', applyTarget: 'https://careers.example.com/apply/9', status: 'needs_review' });
    expect(app.status).toBe('needs_review');
    expect(app.plan.notes.join(' ')).toMatch(/careers\.example\.com\/apply\/9/);
  });

  it('prepare: no longer listed → skipped/expired; an answer the employer does not accept → skipped_screening', async () => {
    h.openError = new ApplyError('expired', 'the job is no longer on JobKarov');
    const a = await prepared();
    expect(repo.getJob(a.job.id)).toMatchObject({ status: 'skipped', statusReason: 'expired: the job is no longer on JobKarov' });
    h.openError = new ApplyError('screening_mismatch', '"כמה שנות ניסיון": the employer accepts only "3-5 שנים"; your answer is "עד שנתיים"');
    const b = await prepared();
    expect(repo.getJob(b.job.id)!.status).toBe('skipped_screening');
  });

  it('batch: the first CAPTCHA → assisted panel only; the second in the same session pauses the site for 48h, the rest waits', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await prepared()).app.id);
    h.outcome = { kind: 'needs_manual', reason: 'captcha', message: 'JobKarov asked for a CAPTCHA — not attempted; apply by hand' };
    approveBatch(db, ids);
    await waitIdle();
    expect(h.sent).toHaveLength(2);
    const b = batchProgress()!;
    expect(b.captchas).toBe(2);
    expect(b.results.map((r) => r.status)).toEqual(['needs_manual', 'needs_manual', 'not_sent']);
    expect(b.results[0]!.detail).not.toMatch(/paused/);
    expect(b.results[1]!.detail).toMatch(/second CAPTCHA this session: JobKarov paused for 48 hours/);
    expect(b.results[2]!.detail).toMatch(/JobKarov is paused: CAPTCHA at send twice in a session/);
    expect(pauseOf('jobkarov')).toMatchObject({ reason: 'CAPTCHA at send twice in a session', source: 'block' });
    expect(apps.get(ids[2]!)!.status).toBe('needs_review');
  });

  it('one CAPTCHA per session does not pause: two separate approvals are two sessions', async () => {
    h.outcome = { kind: 'needs_manual', reason: 'captcha', message: 'JobKarov asked for a CAPTCHA — not attempted; apply by hand' };
    for (let i = 0; i < 2; i++) {
      const { app } = await prepared();
      approveApplication(db, app.id);
      await waitIdle();
    }
    expect(h.sent).toHaveLength(2);
    expect(isPaused('jobkarov')).toBe(false);
  });

  it('the assisted panel serves a needs_manual job with email alerts off: helper, open, "I applied"', async () => {
    const app = buildApp(db);
    const job = addJob();
    repo.setStatus(job.id, 'needs_manual', 'captcha');
    const helper = await app.inject({ method: 'GET', url: `/api/linkedin/jobs/${job.id}/helper` });
    expect(helper.statusCode).toBe(200);
    expect(helper.json()).toMatchObject({ site: 'jobkarov', siteLabel: 'JobKarov' });
    expect((await app.inject({ method: 'POST', url: `/api/linkedin/jobs/${job.id}/applied` })).statusCode).toBe(200);
    expect(repo.getJob(job.id)).toMatchObject({ status: 'submitted_manual', statusReason: expect.stringMatching(/^applied by hand on JobKarov/) });
    // a job a site's send did not leave for you stays out of the panel while alerts are off
    const other = addJob();
    expect((await app.inject({ method: 'GET', url: `/api/linkedin/jobs/${other.id}/helper` })).statusCode).toBe(409);
  });
});

describe('JobKarov question answers', () => {
  const NOW = new Date('2026-11-01T00:00:00Z');
  const profile = ProfileSchema.parse({
    contact: { name: { he: 'טסט טסטוב' }, city: {} },
    experience: [{ id: 'exp.acme', company: { en: 'Acme' }, title: { en: 'Developer' }, start: '2021-01', end: '2024-12', skills: ['skill.react'] }],
    skills: [{ id: 'skill.react', name: 'React' }],
    declaredExperience: { totalDevYears: 2, basis: 'two years of development' },
  });
  const p = JSON.parse(fs.readFileSync(new URL('./fixtures/jobkarov-preview.json', import.meta.url), 'utf8')) as JkPreview;
  const q: JkPreview = {
    ...p,
    questions: [
      { sfq_text: 'כמה שנות ניסיון בפיתוח תוכנה', sfq_sfqc_id: '1' },
      { sfq_text: 'ניסיון ב-React', sfq_sfqc_id: '1' },
      { sfq_text: 'רמת אנגלית', sfq_sfqc_id: '2' },
    ],
    Site: { ...p.Site!, require_range: 1 },
  };
  const fields = previewFields(q);
  const entry = (question: string, answer: string, type: BankEntry['type']): BankEntry => ({
    id: 1, question, normKey: questionKey(question), answer, type, options: null, language: 'he', status: 'active', usageCount: 0, source: 'user', createdAt: '', updatedAt: '', lastUsedAt: null,
  });
  const deps = (kind: 'general' | 'technology' | 'unsure', bank: BankEntry[] = [], salaryPosted: NonNullable<ResolveDeps['salary']>['posted'] = null) => {
    const llm = { matchBank: vi.fn(async () => ({ entryId: null, confidence: 0 })), draft: vi.fn(async () => ({ text: 'x', usedFactIds: [], unanswerable: false, flaggedClaims: [] })) };
    const d: ResolveDeps = {
      profile,
      bank: { byKey: (k) => bank.find((b) => b.normKey === k) ?? null, active: () => bank },
      ...llm,
      classifyYears: async () => ({ kind }),
      minConfidence: 0.85,
      job: { title: 'מפתח', text: 'x', language: 'he' },
      salary: { posted: salaryPosted, settings: { floor: null, textAnswerNoRange: '', numericFallback: null, from: { floor: 'unset', textAnswerNoRange: 'unset', numericFallback: 'unset' } } },
      now: NOW,
    };
    return { d, llm };
  };

  it('a general experience question → declaredExperience (2 years → "עד שנתיים")', async () => {
    const r = await resolveField(fields[0]!, deps('general').d);
    expect(r).toMatchObject({ status: 'resolved', value: '2', provenance: { source: 'declared_experience' } });
    expect(optionIdFor(q, 0, r.value!)).toBe('2');
  });

  it('a technology question → the years per skill from work roles (React 4 years → "3-5 שנים"); unsure → pending', async () => {
    const r = await resolveField(fields[1]!, deps('technology').d);
    expect(r).toMatchObject({ status: 'resolved', value: '4', provenance: { source: 'skill_years' } });
    expect(optionIdFor(q, 1, r.value!)).toBe('3');
    expect((await resolveField(fields[1]!, deps('unsure').d)).status).toBe('pending');
  });

  it('a level question → the answers bank only, never the LLM; nothing in the bank → pending', async () => {
    const empty = deps('unsure');
    expect((await resolveField(fields[2]!, empty.d)).status).toBe('pending');
    expect(empty.llm.draft).not.toHaveBeenCalled();
    const banked = deps('unsure', [entry('רמת אנגלית', 'טוב מאוד', 'choice')]);
    expect(await resolveField(fields[2]!, banked.d)).toMatchObject({ status: 'resolved', value: 'טוב מאוד', provenance: { source: 'bank' } });
    expect(banked.llm.draft).not.toHaveBeenCalled();
  });

  it('the salary range: the posted range (upper half) → the closest range; nothing fits → pending', async () => {
    const posted = { min: 12000, max: 16000, unit: 'month' as const, source: 'description' as const, text: '12,000-16,000' };
    const r = await resolveField(fields[3]!, deps('unsure', [], posted).d);
    expect(r).toMatchObject({ status: 'resolved', value: '14000', provenance: { source: 'salary' } });
    expect(q.Ranges![rangeIdFor(Number(r.value), q.Ranges)!]).toBe('12000-15000');
    expect((await resolveField(fields[3]!, deps('unsure').d)).status).toBe('pending');
  });
});
