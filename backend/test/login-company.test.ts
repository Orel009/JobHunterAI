/**
 * (1) Jobs that failed only on "not logged in" go back to "queued" once the session is valid again.
 * (2) Excluded companies: saving takes queued / in-review jobs out, and nothing is sent to one (final check).
 * Stand-ins for the Drushim pages; own data folder and preferences; DRY_RUN off — submissions are stand-ins too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-login';
  process.env.PREFERENCES_FILE = 'data/test-login/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { panels: 0, submits: 0, onFill: null as null | (() => void) };
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
  openPanel: async () => {
    h.panels++;
    return { fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false };
  },
  fillPanel: async () => h.onFill?.(),
  screenshotPanel: async () => 'shot.png',
  submitPanel: async () => {
    h.submits++;
    return { outcome: { kind: 'submitted' }, confirmationText: 'ok', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { Applications } from '../src/apply/plan.js';
import { approveApplication, prepareJobs } from '../src/apply/service.js';
import { refilterExisting, waitIdle } from '../src/pipeline/runner.js';
import { loadPrefs } from '../src/core/prefs.js';
import { setSession } from '../src/browser/site-session.js';
import { buildApp } from '../src/server/app.js';
import { saveAutoSubmitSettings } from '../src/apply/auto-submit.js';
import type { ApplyPlan } from '../src/apply/types.js';

const PREFS = (exclude: string[] = []) =>
  `cv: { he: cv.pdf, en: cv.pdf }\nfilters: { excludeCompanies: [${exclude.join(', ')}] }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack] }\n`;
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });

let db: DB;
let repo: Repo;
const add = (id: string, company = `Co ${id}`) => {
  const j = toJob({
    site: 'drushim', externalId: id, company, title: 'Full Stack Developer', location: '', descriptionText: 'React', requirementsText: '',
    url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {},
  });
  repo.upsertJob(j);
  repo.setPrefilter(j.id, true, 'ok');
  repo.saveScore(j.id, { score: 95, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
  return repo.getJob(j.id)!;
};
const inReview = (id: string, company?: string) => {
  const job = add(id, company);
  const plan: ApplyPlan = { jobId: job.id, site: 'drushim', createdAt: '', cv: { lang: 'he', cvName: 'cv.pdf', hebrewRatio: 1, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] };
  repo.setStatus(job.id, 'needs_review', 'plan ready');
  return new Applications(db).savePlan(job, plan, 'needs_review');
};
const job = (id: string) => repo.getJob(jobId('drushim', id))!;

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  h.panels = 0;
  h.submits = 0;
  h.onFill = null;
  fs.writeFileSync(config.paths.preferences, PREFS());
  saveAutoSubmitSettings({ sites: {}, paused: false, pausedAt: null, minRank: 90 });
  setSession('drushim', { state: 'unknown', checkedAt: null, detail: 'test' });
});

describe('failed on "not logged in" → back to queued once the session is valid', () => {
  it('only login failures are requeued; their stuck application is closed', () => {
    const app = inReview('1');
    new Applications(db).update(app.id, { status: 'approved' });
    repo.setStatus(job('1').id, 'failed', 'Drushim session is not logged in — run: npm run login -- drushim');
    add('2');
    repo.setStatus(job('2').id, 'failed', 'CV "x.pdf" not found');
    expect(repo.requeueLoginFailures('drushim')).toBe(1);
    expect(job('1')).toMatchObject({ status: 'queued', statusReason: 'back in the queue: the login is valid again' });
    expect(new Applications(db).get(app.id)!.status).toBe('failed');
    expect(job('2').status).toBe('failed');
  });

  it('the running app requeues as soon as the session is confirmed (session check, job page opened)', () => {
    buildApp(db);
    add('3');
    repo.setStatus(job('3').id, 'failed', 'login form opened instead of the apply panel — log in again');
    setSession('drushim', { state: 'logged_out', checkedAt: null, detail: 'probe 401' });
    expect(job('3').status).toBe('failed');
    setSession('drushim', { state: 'logged_in', checkedAt: null, detail: 'probe 401→200' });
    expect(job('3').status).toBe('queued');
  });
});

describe('excluded companies in the apply flow', () => {
  it('saving preferences moves queued / in-review jobs of an excluded company to skipped_company', () => {
    const app = inReview('10', 'matrix (פינטק)');
    add('11', 'matrix (בנקאות)');
    repo.setStatus(job('11').id, 'queued', 'preparing application');
    inReview('12', 'Acme');
    fs.writeFileSync(config.paths.preferences, PREFS(['matrix', 'מטריקס']));
    const r = refilterExisting(repo, loadPrefs());
    expect(r.newlySkipped).toBeGreaterThanOrEqual(2);
    expect(job('10')).toMatchObject({ status: 'skipped_company', statusReason: 'excluded company: matrix (פינטק) (matches "matrix")' });
    expect(new Applications(db).get(app.id)!.status).toBe('skipped');
    expect(job('11').status).toBe('skipped_company');
    expect(job('12').status).toBe('needs_review');
  });

  it('approved before the company was excluded → not sent (final check)', async () => {
    const app = inReview('20', 'matrix (בנקאות)');
    fs.writeFileSync(config.paths.preferences, PREFS(['matrix']));
    approveApplication(db, app.id);
    await waitIdle();
    expect(h.submits).toBe(0);
    expect(h.panels).toBe(0);
    expect(job('20').status).toBe('skipped_company');
    expect(new Applications(db).get(app.id)!.status).toBe('skipped');
  });

  it('excluded while the panel was being filled → stopped right before the final click (approved and auto-submit)', async () => {
    const app = inReview('21', 'Globex');
    h.onFill = () => fs.writeFileSync(config.paths.preferences, PREFS(['globex']));
    approveApplication(db, app.id);
    await waitIdle();
    expect(h.submits).toBe(0);
    expect(job('21').status).toBe('skipped_company');

    fs.writeFileSync(config.paths.preferences, PREFS());
    saveAutoSubmitSettings({ sites: { drushim: true } });
    add('22', 'Initech');
    let fills = 0;
    h.onFill = () => {
      if (++fills === 2) fs.writeFileSync(config.paths.preferences, PREFS(['initech'])); // the full fill before sending
    };
    prepareJobs(db, [jobId('drushim', '22')]);
    await waitIdle();
    expect(h.submits).toBe(0);
    expect(job('22').status).toBe('skipped_company');
  });
});
