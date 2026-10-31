/**
 * LinkedIn job alerts are optional and OFF by default: with the toggle off and no IMAP settings at all, the app
 * starts and a full --hunt runs, and no IMAP code is ever loaded. Uses its own data folder, a stand-in Drushim
 * adapter and browser (no network), and the test-mode model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-linkedin';
  for (const k of ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_APP_PASSWORD']) delete process.env[k];
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { imapConstructed: 0, mailParsed: 0, pages: 0 };
});

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor() {
      env.imapConstructed++;
      throw new Error('IMAP must not be used in this test');
    }
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: () => {
    env.mailParsed++;
    throw new Error('mail parsing must not be used in this test');
  },
}));
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => {
    env.pages++;
    return {} as never;
  },
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/registry.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/registry.js')>();
  const card = {
    site: 'drushim' as const,
    externalId: '99000001',
    company: 'Acme',
    title: 'Full Stack Developer',
    location: 'חיפה',
    descriptionText: '',
    requirementsText: '',
    url: 'https://www.drushim.co.il/job/99000001/aa/',
    postedAt: null,
    applyType: 'site_one_click' as const,
    applyTarget: '',
    language: 'he' as const,
    detailsFetched: false,
    raw: {},
  };
  const fake = {
    id: 'drushim' as const,
    displayName: 'Drushim',
    loginUrl: 'https://www.drushim.co.il/',
    async *search() {
      yield card;
    },
    async getDetails() {
      return { ...card, descriptionText: 'פיתוח Full Stack ב-React ו-Node.js', requirementsText: 'ניסיון של שנה', detailsFetched: true };
    },
  };
  return { ...real, adapters: { drushim: fake }, getAdapter: (id: string) => (id === 'drushim' ? fake : real.getAdapter(id)) };
});

import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { buildApp } from '../src/server/app.js';
import { runHunt } from '../src/pipeline/hunt.js';
import { waitIdle } from '../src/pipeline/runner.js';
import { importAlertEmails } from '../src/linkedin/importer.js';
import { config } from '../src/config.js';
import { profilePath } from '../src/profile/facts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// the toggle and the profile live in this test's own data folder; start and end without them (the log file stays open)
const reset = () => {
  for (const p of [path.join(config.dataDir, 'settings.json'), config.paths.profileDir]) fs.rmSync(p, { recursive: true, force: true });
};
beforeAll(reset);
afterAll(reset);

describe('LinkedIn job alerts are optional (off by default)', () => {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const repo = new Repo(db);

  it('with the toggle off and no IMAP config, the app starts and a full --hunt runs', async () => {
    expect(config.dataDir).toMatch(/test-linkedin$/);
    expect(process.env.IMAP_USER).toBeUndefined();
    fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
    fs.writeFileSync(profilePath(), JSON.stringify({ contact: { name: { he: 'דנה', en: 'Dana Test' }, city: {} }, gender: 'female', skills: [{ id: 'skill.react', name: 'React' }] }));
    const status = await app.inject({ method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().linkedin).toEqual({ enabled: false });

    const h = await runHunt(db, { checkSession: async () => ({ state: 'logged_in', checkedAt: null, detail: 'stub' }), notify: () => undefined });
    expect(h.runs).toEqual([{ site: 'drushim', status: 'done', reason: null, inserted: 1, scored: 1 }]);
    expect(h.note).toMatch(/no new jobs/);
    expect(repo.listRuns(10).map((r) => (r as unknown as { site: string }).site)).toEqual(['drushim']);
    expect(env.imapConstructed).toBe(0);
    expect(env.mailParsed).toBe(0);
  });

  it('while off: nothing about IMAP runs, and the LinkedIn endpoints refuse', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/linkedin/settings' })).json()).toMatchObject({ enabled: false, configured: false });
    for (const url of ['/api/linkedin/fetch', '/api/linkedin/test']) {
      const r = await app.inject({ method: 'POST', url });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/turned off/);
    }
    expect(env.imapConstructed).toBe(0);
  });

  it('turned on without IMAP settings: the fetch run fails with a clear message, still without connecting', async () => {
    const on = await app.inject({ method: 'PUT', url: '/api/linkedin/settings', payload: { enabled: true } });
    expect(on.json()).toMatchObject({ enabled: true, configured: false });
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().linkedin).toEqual({ enabled: true });
    expect((await app.inject({ method: 'POST', url: '/api/linkedin/fetch' })).statusCode).toBe(200);
    await waitIdle();
    expect(repo.listRuns(1)[0]).toMatchObject({ site: 'email-alerts', status: 'failed', reason: expect.stringMatching(/IMAP is not set up/) });
    expect(env.imapConstructed).toBe(0);
  });

  it('assisted apply: helper data, "I applied", and the automated flow refuses LinkedIn jobs', async () => {
    importAlertEmails(db, [{ messageId: '<a@x>', date: null, html: fs.readFileSync(path.join(here, 'fixtures', 'linkedin-alert-cards.html'), 'utf8'), text: null }]);
    const job = repo.listJobs({ site: 'linkedin', q: 'Globex' }).items[0]!;
    const helper = (await app.inject({ method: 'GET', url: `/api/linkedin/jobs/${job.id}/helper` })).json();
    expect(helper).toMatchObject({ cv: { lang: 'en', file: 'cv-en.pdf' }, incompleteInfo: true });

    const apply = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/apply` });
    expect(apply.statusCode).toBe(400);
    expect(apply.json().error).toMatch(/applied to by hand/);

    expect((await app.inject({ method: 'POST', url: `/api/linkedin/jobs/${job.id}/applied` })).statusCode).toBe(200);
    const row = db.prepare('SELECT status, applied_manually_at FROM jobs WHERE id = ?').get(job.id) as { status: string; applied_manually_at: string };
    expect(row.status).toBe('submitted_manual');
    expect(Date.parse(row.applied_manually_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('turning it off again keeps imported jobs and history, and stops fetching', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/linkedin/settings', payload: { enabled: false } })).json()).toMatchObject({ enabled: false });
    const jobs = (await app.inject({ method: 'GET', url: '/api/jobs?site=linkedin' })).json();
    expect(jobs.total).toBe(3);
    expect(jobs.items.some((j: { status: string }) => j.status === 'submitted_manual')).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/linkedin/fetch' })).statusCode).toBe(409);
    expect(env.imapConstructed).toBe(0);
    expect(env.pages).toBeGreaterThan(0); // the Drushim run used the (stand-in) browser; LinkedIn never did
  });
});
