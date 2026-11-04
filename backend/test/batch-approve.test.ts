/**
 * Batch approval: who can be selected (drafts, pending answers and flagged claims need individual review), sequential
 * sends best-first, and the stop conditions (CAPTCHA / bot protection, a daily cap, the site session).
 * Stand-ins for the Drushim pages; own data folder and preferences; DRY_RUN off — submissions are stand-ins too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-batch';
  process.env.PREFERENCES_FILE = 'data/test-batch/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { sent: [] as string[], failOn: null as null | { n: number; kind: 'captcha' | 'session' }, sendCaptcha: false, paces: [] as Array<[number, number]> };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async (a?: number, b?: number) => void h.paces.push([a ?? 0, b ?? 0]),
}));
vi.mock('../src/sites/jobmaster/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/jobmaster/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => ({ fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false }),
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
  submitPanel: async () => {
    h.sent.push('jobmaster');
    return { outcome: { kind: 'submitted' }, confirmationText: 'ok', screenshotAfter: 'after.png' };
  },
}));
vi.mock('../src/sites/drushim/apply.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/drushim/apply.js')>();
  const { BlockedError } = await import('../src/browser/session.js');
  let opened = 0;
  return {
    ...real,
    fetchAppliedJobs: async () => new Map(),
    installDryRunGuard: async () => async () => undefined,
    openPanel: async (_p: unknown, url: string) => {
      if (url.includes('/prep/')) return { fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false };
      opened++;
      if (h.failOn && opened === h.failOn.n) {
        if (h.failOn.kind === 'captcha') throw new BlockedError('captcha');
        throw new real.ApplyError('not_logged_in', 'not logged in to drushim');
      }
      return { fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false };
    },
    fillPanel: async () => undefined,
    screenshotPanel: async () => 'shot.png',
    submitPanel: async (_p: unknown, externalId: number) => {
      h.sent.push(String(externalId));
      if (h.sendCaptcha) return { outcome: { kind: 'needs_manual', reason: 'captcha', message: 'the site asked for a CAPTCHA — not attempted' }, confirmationText: null, screenshotAfter: 'after.png' };
      return { outcome: { kind: 'submitted' }, confirmationText: 'עבודה טובה!', screenshotAfter: 'after.png' };
    },
    __reset: () => (opened = 0),
  };
});

import fs from 'node:fs';
import path from 'node:path';
import { clearResume, israelTime, pauseOf, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { resetSendTimes } from '../src/apply/pacing.js';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { approveBatch, batchBlock, batchProgress } from '../src/apply/service.js';
import { Applications, type ApplicationRow } from '../src/apply/plan.js';
import { saveAutoSubmitSettings } from '../src/apply/auto-submit.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';
import * as drushimApply from '../src/sites/drushim/apply.js';

const PREFS = 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n';
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, PREFS);

const field = (extra: Partial<ResolvedField> = {}): ResolvedField =>
  ({ field: { key: 'q', label: 'Do you live nearby?', type: 'yes_no', required: true }, normKey: 'q', status: 'resolved', value: 'yes', provenance: { source: 'profile', confidence: 1 }, ...extra }) as ResolvedField;
const plan = (fields: ResolvedField[] = [], over: Partial<ApplyPlan> = {}): ApplyPlan => ({
  jobId: 'j', site: 'drushim', createdAt: '', cv: { lang: 'he', cvName: 'cv.pdf', hebrewRatio: 1, threshold: 0.2 }, fields, readiness: 'ready', notes: [], ...over,
});
const row = (p: ApplyPlan, status = 'needs_review') => ({ id: 1, status, plan: p }) as unknown as ApplicationRow;

describe('who can be batch-approved', () => {
  it('a ready plan from your profile and bank → yes', () => {
    expect(batchBlock(row(plan([field()])))).toBeNull();
    expect(batchBlock(row(plan([]), 'dry_run_ok'))).toBeNull();
  });
  it.each<[string, ApplicationRow, RegExp]>([
    ['a model-written draft', row(plan([field({ status: 'draft', provenance: { source: 'draft' } })], { readiness: 'has_drafts' })), /draft written by the model/],
    ['a pending answer', row(plan([field({ status: 'pending', value: null })], { readiness: 'needs_answers' })), /answer pending/],
    ['flagged claims', row(plan([field({ provenance: { source: 'draft', flaggedClaims: ['10 years of Go'] } })])), /flagged claims/],
    ['no CV', row(plan([], { cv: null })), /no CV/],
    ['a false required statement', row(plan([], { readiness: 'blocked_no' })), /blocked_no/],
    ['already submitted', row(plan([]), 'submitted'), /submitted/],
  ])('%s → individual review', (_n, app, why) => {
    expect(batchBlock(app)).toMatch(why);
  });
});

let db: DB;
let repo: Repo;
let apps: Applications;
/** a needs_review application for a job with this score */
const waiting = (id: string, score: number, p: ApplyPlan = plan()) => {
  const j = toJob({
    site: 'drushim', externalId: id, company: `Co ${id}`, title: 'Full Stack Developer', location: '', descriptionText: 'React developer', requirementsText: '',
    url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {},
  });
  repo.upsertJob(j);
  repo.setPrefilter(j.id, true, 'ok');
  repo.saveScore(j.id, { score, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
  return apps.savePlan(repo.getJob(j.id)!, { ...p, jobId: j.id }, 'needs_review').id;
};
const status = (id: string) => apps.latestForJob(jobId('drushim', id))!.status;
/** the same on another site (JobMaster) */
const waitingOn = (site: 'jobmaster', id: string, score: number) => {
  const j = toJob({
    site, externalId: id, company: `Other ${id}`, title: 'Full Stack Developer', location: '', descriptionText: 'React developer', requirementsText: '',
    url: `https://www.jobmaster.co.il/jobs/checknum.asp?key=${id}`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {},
  });
  repo.upsertJob(j);
  repo.setPrefilter(j.id, true, 'ok');
  repo.saveScore(j.id, { score, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
  return apps.savePlan(repo.getJob(j.id)!, { ...plan(), site, jobId: j.id }, 'needs_review').id;
};

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.sent = [];
  h.failOn = null;
  h.sendCaptcha = false;
  (drushimApply as unknown as { __reset(): void }).__reset();
  saveAutoSubmitSettings({ sites: { drushim: false }, minRank: 90, paused: false, pausedAt: null });
  fs.writeFileSync(config.paths.preferences, PREFS);
  for (const s of Object.keys(sitePauses())) unpauseSite(s); // a block in one test pauses the site for 48h
  clearResume('drushim');
  resetSendTimes();
  h.paces = [];
});

describe('approve selected → submit', () => {
  it('sends one after another, best rank first, and reports each result', async () => {
    const ids = [waiting('1', 80), waiting('2', 97), waiting('3', 90)];
    const r = approveBatch(db, ids);
    expect(r).toMatchObject({ dryRun: false, accepted: 3, refused: [] });
    await waitIdle();
    expect(h.sent).toEqual(['2', '3', '1']);
    expect(['1', '2', '3'].map(status)).toEqual(['submitted', 'submitted', 'submitted']);
    const b = batchProgress()!;
    expect(b).toMatchObject({ total: 3, done: 3, finished: true, stoppedReason: null, current: null });
    expect(b.results.map((x) => x.status)).toEqual(['submitted', 'submitted', 'submitted']);
    expect(repo.listRuns(1)[0]).toMatchObject({ kind: 'submit_batch', status: 'done' });
  });

  it('refuses drafts / pending answers / flagged claims, sends the rest', async () => {
    const good = waiting('4', 95);
    const draft = waiting('5', 99, plan([field({ status: 'draft', provenance: { source: 'draft' } })], { readiness: 'has_drafts' }));
    const flagged = waiting('6', 99, plan([field({ provenance: { source: 'draft', flaggedClaims: ['x'] } })]));
    const r = approveBatch(db, [good, draft, flagged]);
    expect(r.accepted).toBe(1);
    expect(r.refused.map((x) => x.appId).sort()).toEqual([draft, flagged].sort());
    await waitIdle();
    expect(h.sent).toEqual(['4']);
    expect([status('5'), status('6')]).toEqual(['needs_review', 'needs_review']);
  });

  it('nothing eligible → refused outright', () => {
    const draft = waiting('7', 99, plan([field({ status: 'pending', value: null })], { readiness: 'needs_answers' }));
    expect(() => approveBatch(db, [draft])).toThrow(/nothing to approve/);
  });

  it('bot protection stops the batch and pauses the site; that site\'s unsent jobs → the assisted panel', async () => {
    h.failOn = { n: 2, kind: 'captcha' };
    const ids = [waiting('10', 99), waiting('11', 98), waiting('12', 97)];
    approveBatch(db, ids);
    await waitIdle();
    expect(h.sent).toEqual(['10']);
    expect([status('10'), status('11'), status('12')]).toEqual(['submitted', 'skipped', 'skipped']);
    for (const id of ['11', '12']) expect(repo.getJob(jobId('drushim', id))).toMatchObject({ status: 'needs_manual', statusReason: 'bot_protection' });
    const b = batchProgress()!;
    const p = pauseOf('drushim')!;
    expect(p).toMatchObject({ reason: 'CAPTCHA / bot check', source: 'block' });
    expect(b.stoppedReason).toMatch(/CAPTCHA \/ bot protection — stopped \(never bypassed\) · Drushim: paused until \w{3} \d\d\.\d\d \d\d:\d\d \(Israel time\); 2 unsent job\(s\) moved to the assisted panel/);
    expect(b.results.map((x) => x.status)).toEqual(['submitted', 'needs_manual', 'needs_manual']);
    expect(b.results[1]!.stop).toBe('captcha');
    expect(b.results[2]!.detail).toMatch(/Drushim paused until .* moved to the assisted panel: apply in your regular browser/);
    expect(b.paused).toEqual([{ site: 'drushim', label: 'Drushim', reason: 'CAPTCHA / bot check', until: p.until, untilText: israelTime(p.until), repause: false, toAssisted: 2 }]);
  });

  it('bot protection on one site: another site\'s unsent jobs stay in the review queue', async () => {
    h.failOn = { n: 2, kind: 'captcha' };
    const jm = waitingOn('jobmaster', '900', 50);
    approveBatch(db, [waiting('13', 99), waiting('14', 98), jm]);
    await waitIdle();
    expect(apps.get(jm)!.status).toBe('needs_review');
    expect(batchProgress()!.results.find((x) => x.appId === jm)).toMatchObject({ status: 'not_sent', detail: expect.stringMatching(/still in the review queue \(this site is not paused/) });
    expect(status('14')).toBe('skipped');
  });

  it('a CAPTCHA at send twice in one session pauses the site (Drushim too); the first alone does not', async () => {
    h.sendCaptcha = true;
    approveBatch(db, [waiting('30', 99), waiting('31', 98), waiting('32', 97)]);
    await waitIdle();
    expect(h.sent).toEqual(['30', '31']);
    expect(batchProgress()!.results.map((x) => x.status)).toEqual(['needs_manual', 'needs_manual', 'needs_manual']);
    expect(pauseOf('drushim')).toMatchObject({ reason: 'CAPTCHA at send twice in a session' });
    expect(status('32')).toBe('skipped'); // never attempted: the site paused → the assisted panel
  });

  it('a session problem stops the batch', async () => {
    h.failOn = { n: 1, kind: 'session' };
    approveBatch(db, [waiting('20', 99), waiting('21', 98)]);
    await waitIdle();
    expect(h.sent).toEqual([]);
    expect(batchProgress()!.stoppedReason).toMatch(/not logged in/);
    expect(status('21')).toBe('needs_review');
  });

  it('the daily cap holds back that site only (counting earlier submissions today); the batch goes on', async () => {
    fs.writeFileSync(config.paths.preferences, PREFS + 'limits: { dailyApplyLimit: 2 }\n');
    approveBatch(db, [waiting('30', 99), waiting('31', 98), waiting('32', 97)]);
    await waitIdle();
    expect(h.sent).toEqual(['30', '31']);
    const b = batchProgress()!;
    expect(b.stoppedReason).toBeNull();
    expect(b.results.map((x) => x.status)).toEqual(['submitted', 'submitted', 'not_sent']);
    expect(b.results[2]!.detail).toMatch(/Drushim: the daily limit \(2\) is reached/);
    expect(status('32')).toBe('needs_review');
  });

  it('Drushim: at most 12 sends a day by default (under the general 15)', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => waiting(String(200 + i), 99 - i));
    // two sessions of 8 + 5: the session cap first, then the daily cap
    approveBatch(db, ids.slice(0, 8));
    await waitIdle();
    approveBatch(db, ids.slice(8));
    await waitIdle();
    expect(h.sent).toHaveLength(12);
    expect(batchProgress()!.results.at(-1)).toMatchObject({ status: 'not_sent', detail: expect.stringMatching(/Drushim: the daily limit \(12\) is reached/) });
  });

  it('Drushim: at most 8 sends per session by default; the rest stay in review for the next session', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => waiting(String(100 + i), 99 - i));
    approveBatch(db, ids);
    await waitIdle();
    expect(h.sent).toHaveLength(8);
    const b = batchProgress()!;
    expect(b.stoppedReason).toBeNull();
    expect(b.results.slice(8).map((x) => [x.status, x.detail])).toEqual([
      ['not_sent', 'Drushim: 8 sends this session (the most per session) — the rest wait for the next session'],
      ['not_sent', 'Drushim: 8 sends this session (the most per session) — the rest wait for the next session'],
    ]);
    expect(status('108')).toBe('needs_review');
  });

  it('per-site pacing from Preferences: the session cap of 2', async () => {
    fs.writeFileSync(config.paths.preferences, PREFS + 'pacing:\n  drushim: { maxSendsPerSession: 2 }\n');
    approveBatch(db, [waiting('40', 99), waiting('41', 98), waiting('42', 97)]);
    await waitIdle();
    expect(h.sent).toEqual(['40', '41']);
  });

  it('between two Drushim sends: a 60–150 s wait (spent on a job list), never straight from send to send', async () => {
    h.paces = [];
    approveBatch(db, [waiting('50', 99), waiting('51', 98), waiting('52', 97)]);
    await waitIdle();
    expect(h.sent).toEqual(['50', '51', '52']);
    // the pacing waits come in 5 s chunks; two waits (before the 2nd and the 3rd send), each 60–150 s
    const chunks = h.paces.filter(([a, b]) => a === b && a <= 5000);
    const total = chunks.reduce((n, [a]) => n + a, 0);
    expect(total).toBeGreaterThanOrEqual(2 * 59_000);
    expect(total).toBeLessThanOrEqual(2 * 150_000);
  });
});
