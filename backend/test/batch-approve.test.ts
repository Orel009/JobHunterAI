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
  return { sent: [] as string[], failOn: null as null | { n: number; kind: 'captcha' | 'session' } };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
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
      return { outcome: { kind: 'submitted' }, confirmationText: 'עבודה טובה!', screenshotAfter: 'after.png' };
    },
    __reset: () => (opened = 0),
  };
});

import fs from 'node:fs';
import path from 'node:path';
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

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.sent = [];
  h.failOn = null;
  (drushimApply as unknown as { __reset(): void }).__reset();
  saveAutoSubmitSettings({ sites: { drushim: false }, minRank: 90, paused: false, pausedAt: null });
  fs.writeFileSync(config.paths.preferences, PREFS);
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

  it('a CAPTCHA stops the batch; the rest stay in the review queue', async () => {
    h.failOn = { n: 2, kind: 'captcha' };
    const ids = [waiting('10', 99), waiting('11', 98), waiting('12', 97)];
    approveBatch(db, ids);
    await waitIdle();
    expect(h.sent).toEqual(['10']);
    expect([status('10'), status('11'), status('12')]).toEqual(['submitted', 'failed', 'needs_review']);
    const b = batchProgress()!;
    expect(b.stoppedReason).toMatch(/CAPTCHA/);
    expect(b.results.map((x) => x.status)).toEqual(['submitted', 'failed', 'not_sent']);
    expect(b.results[1]!.stop).toBe('captcha');
  });

  it('a session problem stops the batch', async () => {
    h.failOn = { n: 1, kind: 'session' };
    approveBatch(db, [waiting('20', 99), waiting('21', 98)]);
    await waitIdle();
    expect(h.sent).toEqual([]);
    expect(batchProgress()!.stoppedReason).toMatch(/not logged in/);
    expect(status('21')).toBe('needs_review');
  });

  it('the daily cap stops the batch (counting earlier submissions today)', async () => {
    fs.writeFileSync(config.paths.preferences, PREFS + 'limits: { dailyApplyLimit: 2 }\n');
    approveBatch(db, [waiting('30', 99), waiting('31', 98), waiting('32', 97)]);
    await waitIdle();
    expect(h.sent).toEqual(['30', '31']);
    const b = batchProgress()!;
    expect(b.stoppedReason).toMatch(/daily cap/);
    expect(b.results.map((x) => x.status)).toEqual(['submitted', 'submitted', 'not_sent']);
    expect(status('32')).toBe('needs_review');
  });
});
