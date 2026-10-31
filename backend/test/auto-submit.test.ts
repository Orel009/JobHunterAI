/**
 * Auto-submit: every gate condition, and the kill switch (before a run and right before the final click).
 * Stand-ins for the Drushim pages; own data folder and preferences; DRY_RUN off — submissions are stand-ins too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-auto';
  process.env.PREFERENCES_FILE = 'data/test-auto/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { submits: 0, onFill: null as null | (() => void) };
});

vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/drushim/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/drushim/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => ({ fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false }),
  fillPanel: async () => h.onFill?.(),
  screenshotPanel: async () => 'shot.png',
  submitPanel: async () => {
    h.submits++;
    return { outcome: { kind: 'submitted' }, confirmationText: 'עבודה טובה!', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { prepareJobs } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import { autoSubmitGate, pauseAutoSubmit, saveAutoSubmitSettings, type GateInput } from '../src/apply/auto-submit.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

// ---------- the gate, condition by condition ----------
const field = (source: string, extra: Partial<ResolvedField> = {}): ResolvedField =>
  ({ field: { key: 'q', label: 'q', type: 'yes_no', required: true }, normKey: 'q', status: 'resolved', value: 'yes', provenance: { source, confidence: 1 }, ...extra }) as ResolvedField;
const okPlan = (fields: ResolvedField[] = [field('profile'), field('bank'), field('salary')]): ApplyPlan => ({
  jobId: 'j', site: 'drushim', createdAt: '', cv: { lang: 'he', cvName: 'cv.pdf', hebrewRatio: 1, threshold: 0.2 }, fields, readiness: 'ready', notes: [],
});
const ok: GateInput = {
  dryRun: false, site: 'drushim', siteEnabled: true, paused: false, automatedFlow: true, rank: 95, minRank: 90, plan: okPlan(),
  descriptionText: 'React developer', company: 'Acme', companyNorm: 'acme', cooldownDays: 30, recentlyAppliedToCompany: false,
  excludedMatch: null, submittedToday: 3, dailyLimit: 15,
};
const failing = (i: GateInput) => autoSubmitGate(i).conditions.filter((c) => !c.ok).map((c) => c.name);

describe('auto-submit gate', () => {
  it('passes only when every condition holds, and records each one', () => {
    const g = autoSubmitGate(ok);
    expect(g.auto).toBe(true);
    expect(g.conditions).toHaveLength(10);
    expect(g.conditions.every((c) => c.ok && c.detail)).toBe(true);
  });

  it.each<[string, Partial<GateInput>, string]>([
    ['DRY_RUN on', { dryRun: true }, 'DRY_RUN is off'],
    ['site toggle off', { siteEnabled: false }, 'auto-submit is on for drushim'],
    ['kill switch', { paused: true }, 'not paused'],
    ['no automated flow (external / LinkedIn)', { automatedFlow: false }, 'the site has an automated apply flow'],
    ['rank below the minimum', { rank: 89 }, 'rank ≥ 90'],
    ['not scored', { rank: null }, 'rank ≥ 90'],
    ['company cooldown', { recentlyAppliedToCompany: true }, 'no application to this company in 30 days'],
    ['confidential company', { company: '- חסוי -', companyNorm: 'חסוי' }, 'no application to this company in 30 days'],
    ['excluded company', { excludedMatch: 'matrix' }, 'company not on your excluded list'],
    ['daily limit reached', { submittedToday: 15 }, "under today's limit for drushim"],
    ['incomplete info', { descriptionText: '' }, 'full job description (not "incomplete info")'],
  ])('%s → not sent', (_n, change, condition) => {
    expect(failing({ ...ok, ...change })).toEqual([condition]);
    expect(autoSubmitGate({ ...ok, ...change }).auto).toBe(false);
  });

  it.each<[string, ResolvedField]>([
    ['a model-written draft', field('draft', { status: 'draft' })],
    ['a pending question', field('none', { status: 'pending', value: null })],
    ['a bank answer the model matched (not exact)', field('bank', { provenance: { source: 'bank', confidence: 0.9 } })],
  ])('%s → not sent', (_n, f) => {
    const g = autoSubmitGate({ ...ok, plan: okPlan([field('profile'), f]) });
    expect(g.auto).toBe(false);
    expect(failing({ ...ok, plan: okPlan([field('profile'), f]) })[0]).toMatch(/^every answer from your profile/);
  });

  it('no CV, or a plan that is not ready → not sent', () => {
    expect(autoSubmitGate({ ...ok, plan: { ...okPlan(), cv: null } }).auto).toBe(false);
    expect(autoSubmitGate({ ...ok, plan: { ...okPlan(), readiness: 'has_drafts' } }).auto).toBe(false);
  });
});

// ---------- through the prepare run ----------
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n');

let db: DB;
let repo: Repo;
const prepared = (id: string, score = 95) => {
  const raw = {
    site: 'drushim' as const, externalId: id, company: `Co ${id}`, title: 'Full Stack Developer', location: '', descriptionText: 'React developer', requirementsText: '',
    url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
  };
  const j = toJob(raw);
  repo.upsertJob(j);
  repo.setPrefilter(j.id, true, 'ok');
  repo.saveScore(j.id, { score, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
  return j.id;
};
const app = (id: string) => new Applications(db).latestForJob(jobId('drushim', id))!;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  h.submits = 0;
  h.onFill = null;
  saveAutoSubmitSettings({ sites: { drushim: true }, minRank: 90, paused: false, pausedAt: null });
});

describe('auto-submit in a prepare run (DRY_RUN off)', () => {
  it('all conditions pass → sent without review; the gate is recorded on the application', async () => {
    expect(config.DRY_RUN).toBe(false);
    prepareJobs(db, [prepared('1')]);
    await waitIdle();
    expect(h.submits).toBe(1);
    const a = app('1');
    expect(a.status).toBe('submitted');
    expect(a.gate).toMatchObject({ auto: true, conditions: expect.arrayContaining([expect.objectContaining({ name: 'rank ≥ 90', ok: true })]) });
    expect(repo.getJob(jobId('drushim', '1'))!.status).toBe('submitted');
    expect(repo.listRuns(1)[0]).toMatchObject({ kind: 'prepare', status: 'done' });
  });

  it('kill switch before the run → nothing sent, review queue', async () => {
    pauseAutoSubmit();
    prepareJobs(db, [prepared('2')]);
    await waitIdle();
    expect(h.submits).toBe(0);
    expect(app('2')).toMatchObject({ status: 'needs_review', gate: { auto: false } });
  });

  it('kill switch pressed while the panel is being filled → stopped right before the final click', async () => {
    // fillPanel runs twice per job: the partial fill while preparing, then the full fill before sending → pause in the second
    let fills = 0;
    h.onFill = () => {
      if (++fills === 2) pauseAutoSubmit();
    };
    prepareJobs(db, [prepared('3'), prepared('4')]);
    await waitIdle();
    expect(h.submits).toBe(0);
    // same rank → either may go first: the first is stopped at the final click, the next sees the pause in its gate
    const [first, next] = [app('3'), app('4')].sort((a, b) => a.id - b.id);
    expect(first).toMatchObject({ status: 'needs_review', error: 'auto-submit was paused before sending — review it', gate: { auto: true } });
    expect(next).toMatchObject({ status: 'needs_review', gate: { auto: false } });
  });

  it('auto-submit off for the site, or rank too low → review queue as before', async () => {
    prepareJobs(db, [prepared('5', 60)]);
    await waitIdle();
    expect(app('5').status).toBe('needs_review');
    saveAutoSubmitSettings({ sites: { drushim: false } });
    prepareJobs(db, [prepared('6')]);
    await waitIdle();
    expect(app('6').status).toBe('needs_review');
    expect(h.submits).toBe(0);
  });

  it("the daily limit is counted per site, including this run's own submissions", async () => {
    fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nlimits: { dailyApplyLimit: 1 }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n');
    try {
      prepareJobs(db, [prepared('7'), prepared('8')]);
      await waitIdle();
      expect(h.submits).toBe(1);
      expect([app('7').status, app('8').status].sort()).toEqual(['needs_review', 'submitted']);
    } finally {
      fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n');
    }
  });
});
