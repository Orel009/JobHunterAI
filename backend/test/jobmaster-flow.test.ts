/**
 * JobMaster through the apply service (prepare → review → approve / batch / auto-submit gate), with the site module
 * replaced by stand-ins: CV names per site (no fallback), suitability questions answered only from the answers bank /
 * profile (pending otherwise, never by the model), "no" as a valid answer, and the send through the JobMaster driver.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-jm-flow';
  process.env.PREFERENCES_FILE = 'data/test-jm-flow/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { filled: [] as unknown[], sent: [] as string[], applied: new Map<string, string | null>() };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/jobmaster/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/jobmaster/apply.js')>()),
  fetchAppliedJobs: async () => h.applied,
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => ({
    fields: [{ key: 'suitability.77', label: 'חי/ה את עולם ה-AI ומתנסה באופן יומיומי בכלים חדשים', type: 'yes_no', required: true }],
    cvs: [
      { code: '5550001', name: 'קורות חיים - נועה טסט.pdf', checked: false },
      { code: '5550002', name: 'Noa Test - Resume.pdf', checked: true },
    ],
    hasCoverLetter: false,
    extra: { qtypes: { 'suitability.77': 'Q' }, contactAsked: true, multiSend: 1 },
  }),
  fillPanel: async (_p: unknown, _s: unknown, plan: unknown) => void h.filled.push(plan),
  screenshotPanel: async () => 'shot.png',
  submitPanel: async (_p: unknown, job: { externalId: string }) => {
    h.sent.push(job.externalId);
    return { outcome: { kind: 'submitted' }, confirmationText: 'קורות החיים נשלחו בהצלחה', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { approveApplication, approveBatch, editField, prepareJobs } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import { AnswersBank } from '../src/apply/bank.js';
import { autoSubmitGate, saveAutoSubmitSettings } from '../src/apply/auto-submit.js';
import { hasApplyFlow } from '../src/apply/drivers.js';

const Q = 'חי/ה את עולם ה-AI ומתנסה באופן יומיומי בכלים חדשים';
const prefs = (jm = 'cv: { he: "קורות חיים - נועה טסט.pdf", en: "Noa Test - Resume.pdf" }') =>
  fs.writeFileSync(config.paths.preferences, `cv: { he: drushim-he.pdf, en: drushim-en.pdf }\njobmaster:\n  ${jm}\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n`);
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });

let db: DB;
let repo: Repo;
let apps: Applications;
const scored = (key: string, title = 'מפתח/ת Full Stack', desc = 'פיתוח מערכות ב-React') => {
  const j = toJob({ site: 'jobmaster', externalId: key, company: `חברה ${key}`, title, location: 'תל אביב', descriptionText: desc, requirementsText: '', url: `https://www.jobmaster.co.il/jobs/checknum.asp?key=${key}`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {} });
  repo.upsertJob(j);
  repo.setPrefilter(j.id, true, 'ok');
  repo.saveScore(j.id, { score: 95, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
  return j.id;
};
const app = (key: string) => apps.latestForJob(jobId('jobmaster', key))!;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.filled = [];
  h.sent = [];
  h.applied = new Map();
  prefs();
  saveAutoSubmitSettings({ sites: { drushim: false, jobmaster: false }, minRank: 90, paused: false, pausedAt: null });
});

describe('JobMaster through the apply service', () => {
  it('JobMaster has an automated apply flow; LinkedIn / Indeed do not', () => {
    expect([hasApplyFlow('drushim'), hasApplyFlow('jobmaster'), hasApplyFlow('linkedin'), hasApplyFlow('indeed')]).toEqual([true, true, false, false]);
  });

  it('prepare: the JobMaster CV by the language rule; an unanswered suitability question is pending (never the model)', async () => {
    prepareJobs(db, [scored('1')]);
    await waitIdle();
    const a = app('1');
    expect(a.plan.cv).toMatchObject({ lang: 'he', cvName: 'קורות חיים - נועה טסט.pdf' });
    expect(a.plan.fields[0]).toMatchObject({ field: { key: 'suitability.77' }, status: 'pending', provenance: { source: 'none' } });
    expect(a.status).toBe('needs_review');
    // an English post gets the English JobMaster file
    prepareJobs(db, [scored('2', 'Full Stack Developer', 'Build web apps with React and Node')]);
    await waitIdle();
    expect(app('2').plan.cv).toMatchObject({ lang: 'en', cvName: 'Noa Test - Resume.pdf' });
  });

  it('an answer in the bank is used; "no" is a valid answer (not a false statement)', async () => {
    new AnswersBank(db).upsert({ question: Q, answer: 'לא', type: 'yes_no', options: null, source: 'review' });
    prepareJobs(db, [scored('3')]);
    await waitIdle();
    expect(app('3').plan).toMatchObject({ readiness: 'ready', fields: [{ status: 'resolved', value: 'no', provenance: { source: 'bank' } }] });
    expect(app('3').status).toBe('needs_review');
  });

  it('no JobMaster CV name in Preferences → failed, no fallback to the Drushim names', async () => {
    prefs('cv: { he: "", en: "" }');
    prepareJobs(db, [scored('4')]);
    await waitIdle();
    expect(app('4')).toMatchObject({ status: 'failed', error: expect.stringMatching(/jobmaster\.cv\.he \/ jobmaster\.cv\.en/) });
    expect(repo.getJob(jobId('jobmaster', '4'))!.status).toBe('failed');
  });

  it('approve sends through the JobMaster driver; batch approval works across sites', async () => {
    prepareJobs(db, [scored('5'), scored('6')]);
    await waitIdle();
    editField(db, app('5').id, 'suitability.77', 'yes', true); // answered once → in the bank → the other one too
    expect(app('6').plan.readiness).toBe('ready');
    approveApplication(db, app('5').id);
    await waitIdle();
    expect(h.sent).toEqual(['5']);
    expect(app('5')).toMatchObject({ status: 'submitted', confirmationText: 'קורות החיים נשלחו בהצלחה' });
    approveBatch(db, [app('6').id]);
    await waitIdle();
    expect(h.sent).toEqual(['5', '6']);
    expect(repo.listRuns(1)[0]).toMatchObject({ site: 'jobmaster', kind: 'submit_batch' });
  });

  it('already applied on JobMaster (its own list) → skipped, never sent', async () => {
    h.applied = new Map([['7', '2026-09-05']]);
    prepareJobs(db, [scored('7')]);
    await waitIdle();
    expect(repo.getJob(jobId('jobmaster', '7'))!.status).toBe('skipped');
    expect(h.sent).toEqual([]);
  });

  it('the auto-submit gate accepts JobMaster as an automated flow (toggle per site, off by default)', () => {
    const plan = { jobId: 'j', site: 'jobmaster', createdAt: '', cv: { lang: 'he' as const, cvName: 'x', hebrewRatio: 1, threshold: 0.2 }, fields: [], readiness: 'ready' as const, notes: [] };
    const base = { dryRun: false, site: 'jobmaster', siteEnabled: true, paused: false, automatedFlow: hasApplyFlow('jobmaster'), rank: 95, minRank: 90, plan, descriptionText: 'x', company: 'c', companyNorm: 'c', cooldownDays: 30, recentlyAppliedToCompany: false, excludedMatch: null, submittedToday: 0, dailyLimit: 15 };
    expect(autoSubmitGate(base).auto).toBe(true);
    expect(autoSubmitGate({ ...base, siteEnabled: false }).auto).toBe(false);
  });
});
