/**
 * One job per company + normalized title within the dedupe window (14 days), on any site — the same site under
 * another job id included: at insert, over jobs already stored (startup), and as a final check before every send.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-dedupe';
  process.env.PREFERENCES_FILE = 'data/test-dedupe/preferences.yaml';
  process.env.DRY_RUN = 'false';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { sent: [] as string[] };
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
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
  submitPanel: async (_p: unknown, code: number) => {
    h.sent.push(String(code));
    return { outcome: { kind: 'submitted' }, confirmationText: 'ok', screenshotAfter: 'after.png' };
  },
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { approveBatch } from '../src/apply/service.js';
import { Applications } from '../src/apply/plan.js';
import type { ApplyPlan } from '../src/apply/types.js';
import type { SiteId } from '../src/sites/types.js';

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fs, tier: 1, queries: [x], titleKeywords: [full stack] }\n');

let db: DB;
let repo: Repo;
let apps: Applications;
const add = (site: SiteId, id: string, company = 'GAN HR', title = 'AI Solutions Specialist', firstSeen?: string) => {
  const j = toJob({ site, externalId: id, company, title, location: '', descriptionText: 'x', requirementsText: '', url: `https://example.test/${site}/${id}`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
  repo.upsertJob(j);
  if (firstSeen) db.prepare('UPDATE jobs SET first_seen_at = ? WHERE id = ?').run(firstSeen, j.id);
  return j;
};
const plan = (jobIdV: string): ApplyPlan => ({ jobId: jobIdV, site: 'drushim', createdAt: '', cv: { lang: 'en', cvName: 'cv.pdf', hebrewRatio: 0, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] });
const queue = (j: ReturnType<typeof add>) => apps.savePlan(repo.getJob(j.id)!, plan(j.id), 'needs_review').id;
const sent = (j: ReturnType<typeof add>) => {
  const id = queue(j);
  apps.update(id, { status: 'submitted', submitted: true });
  repo.setStatus(j.id, 'submitted', 'submitted');
  return id;
};
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
  apps = new Applications(db);
  h.sent = [];
});

describe('at insert', () => {
  it('a repost on the SAME site under another id → skipped_duplicate, linked to the original', () => {
    const a = add('jobnet', '13560468');
    const b = add('jobnet', '13560999');
    expect(repo.dedupeNewJob(b, config.DEDUPE_WINDOW_DAYS)).toEqual({ duplicateOf: a.id, absorbed: null });
    expect(repo.getJob(b.id)).toMatchObject({ status: 'skipped_duplicate', duplicateOf: a.id, statusReason: `duplicate of ${a.id}` });
    expect(repo.sourceLinks(a.id).map((l) => l.jobId)).toEqual([a.id, b.id]);
  });
  it('the same job id is an update, not a duplicate; another title or company is another job', () => {
    const a = add('jobnet', '1');
    expect(repo.dedupeNewJob(a, 14).duplicateOf).toBeNull();
    expect(repo.dedupeNewJob(add('jobnet', '2', 'GAN HR', 'QA Engineer'), 14).duplicateOf).toBeNull();
    expect(repo.dedupeNewJob(add('jobnet', '3', 'Other Co'), 14).duplicateOf).toBeNull();
  });
});

describe('over jobs already stored (startup)', () => {
  it('the one already sent stays the original; the open application of the copy is closed', () => {
    const early = add('jobnet', '13560468', 'GAN HR', 'AI Solutions Specialist', day(3)); // like #24: still in review
    const later = add('jobnet', '13560470', 'GAN HR', 'AI Solutions Specialist', day(2)); // like #25: sent
    const openApp = queue(early);
    sent(later);
    expect(repo.dedupeExisting(14)).toEqual([{ id: early.id, of: later.id }]);
    expect(repo.getJob(early.id)).toMatchObject({ status: 'skipped_duplicate', duplicateOf: later.id });
    expect(apps.get(openApp)).toMatchObject({ status: 'rejected', error: expect.stringMatching(/^duplicate of /) });
    expect(repo.getJob(later.id)).toMatchObject({ status: 'submitted', duplicateOf: null });
  });
  it('nothing sent: the copy on a site with an apply flow wins over an alert copy, else the earliest', () => {
    const li = add('linkedin', '111', 'Acme', 'Full Stack Developer', day(5));
    const dr = add('drushim', '222', 'Acme', 'Full Stack Developer', day(4));
    const dr2 = add('drushim', '333', 'Acme', 'Full Stack Developer', day(1));
    expect(repo.dedupeExisting(14).map((m) => m.id).sort()).toEqual([li.id, dr2.id].sort());
    expect(repo.getJob(li.id)!.duplicateOf).toBe(dr.id);
    expect(repo.getJob(dr2.id)!.duplicateOf).toBe(dr.id);
  });
  it('more than 14 days apart, anonymous companies, and two applications already sent: left as they are', () => {
    add('drushim', '1', 'Acme', 'QA', day(40));
    add('drushim', '2', 'Acme', 'QA', day(1));
    add('drushim', '3', 'חסוי', 'Developer', day(2));
    add('drushim', '4', 'חסוי', 'Developer', day(1));
    sent(add('jobnet', '5', 'Beta', 'Dev', day(3)));
    sent(add('jobmaster', '6', 'Beta', 'Dev', day(2)));
    expect(repo.dedupeExisting(14)).toEqual([]);
  });
});

describe('final check before every send', () => {
  it('a second application to the same company + title within 14 days is not sent, on any site', async () => {
    const a = add('drushim', '1001', 'Initech', 'Full Stack Developer');
    const b = add('drushim', '1002', 'Initech', 'Full Stack Developer'); // both live (stored before the rule)
    const ids = [queue(a), queue(b)];
    approveBatch(db, ids);
    await waitIdle();
    expect(h.sent).toHaveLength(1);
    const [first, second] = ids.map((i) => apps.get(i)!).sort((x, y) => (x.status === 'submitted' ? -1 : y.status === 'submitted' ? 1 : 0));
    expect(first!.status).toBe('submitted');
    expect(second).toMatchObject({ status: 'skipped', error: expect.stringMatching(/already sent on drushim .* duplicate of/) });
    expect(repo.getJob(second!.jobId)).toMatchObject({ status: 'skipped_duplicate' });
  });
  it('sentSameJob: by "I applied" too, and only within the window', () => {
    const li = add('linkedin', '9', 'Hooli', 'Backend Developer');
    db.prepare("UPDATE jobs SET status = 'submitted_manual', applied_manually_at = ? WHERE id = ?").run(day(2), li.id);
    const dr = add('drushim', '10', 'Hooli', 'Backend Developer');
    expect(repo.sentSameJob(dr, 14)).toMatchObject({ id: li.id, site: 'linkedin' });
    db.prepare('UPDATE jobs SET applied_manually_at = ? WHERE id = ?').run(day(20), li.id);
    expect(repo.sentSameJob(dr, 14)).toBeNull();
    expect(repo.sentSameJob({ id: 'x', companyNorm: 'חסוי', titleNorm: 'backend developer' }, 14)).toBeNull();
  });
  it('jobId helper sanity', () => expect(jobId('drushim', '1')).toBe(add('drushim', '1').id));
});

describe('placeholder company names are not companies', () => {
  it('"חברה דיסקרטית", "HighTech Company" and the like never merge two jobs', async () => {
    const { isAnonymousCompany, normalizeCompany } = await import('../src/core/text.js');
    for (const c of ['חסוי', 'חברה דיסקרטית', 'חברה דסקרטית', 'HighTech Company', 'Hardware Company', 'חברת הייטק מובילה', 'Confidential']) expect(isAnonymousCompany(normalizeCompany(c))).toBe(true);
    for (const c of ['הפניקס חברה לביטוח', 'SQLink', 'אלביט מערכות', 'GAN HR']) expect(isAnonymousCompany(normalizeCompany(c))).toBe(false);
    add('jobnet', '7001', 'חברה דיסקרטית', 'Backend Developer', day(2));
    add('jobnet', '7002', 'חברה דיסקרטית', 'Backend Developer', day(1));
    expect(repo.dedupeExisting(14)).toEqual([]);
  });
});
