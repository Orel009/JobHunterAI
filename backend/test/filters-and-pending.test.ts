/**
 * Disabled role types as title excludes; the prefilter re-run when Preferences are saved; discovery without an
 * approved profile (scoring waits, then starts by itself after approval). Own data folder and preferences file,
 * a stand-in Drushim adapter and browser, the test-mode model.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-filters';
  process.env.PREFERENCES_FILE = 'data/test-filters/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/registry.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/registry.js')>();
  const card = (id: string, title: string) => ({
    site: 'drushim' as const,
    externalId: id,
    company: 'Acme',
    title,
    location: 'חיפה',
    descriptionText: 'פיתוח ב-React ו-Node.js',
    requirementsText: '',
    url: `https://www.drushim.co.il/job/${id}/x/`,
    postedAt: null,
    applyType: 'site_one_click' as const,
    applyTarget: '',
    language: 'he' as const,
    detailsFetched: true,
    raw: {},
  });
  const fake = {
    id: 'drushim' as const,
    displayName: 'Drushim',
    loginUrl: 'https://www.drushim.co.il/',
    async *search() {
      yield card('1', 'Full Stack Developer');
      yield card('2', 'איש/אשת תמיכה טכנית');
    },
    async getDetails() {
      return null;
    },
  };
  return { ...real, adapters: { drushim: fake }, getAdapter: (id: string) => (id === 'drushim' ? fake : real.getAdapter(id)) };
});

import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { buildApp } from '../src/server/app.js';
import { startRun, waitIdle } from '../src/pipeline/runner.js';
import { disabledRoleKeywords, prefilter } from '../src/core/prefilter.js';
import { loadPrefs, PrefsSchema } from '../src/core/prefs.js';
import { profilePath } from '../src/profile/facts.js';

const reset = () => {
  for (const p of [config.paths.profileDir, config.paths.preferences]) fs.rmSync(p, { recursive: true, force: true });
};
beforeAll(() => {
  reset();
  fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), '..', 'preferences.example.yaml'), config.paths.preferences);
});
afterAll(reset);

describe('disabled role types exclude their titles', () => {
  const prefs = PrefsSchema.parse({
    roleTypes: [
      { id: 'fullstack', tier: 1, queries: ['Full Stack'], titleKeywords: ['full stack', 'developer'] },
      { id: 'support', tier: 3, enabled: false, queries: ['תמיכה טכנית'], titleKeywords: ['תמיכה טכנית', 'איש תמיכה', 'אשת תמיכה', 'tier 1', 'tier 2', 'developer'] },
      { id: 'junior', tier: 1, enabled: false, searchOnly: true, queries: ['junior'], titleKeywords: ['junior'] },
    ],
  });

  it('skips support titles found by another query, with the reason', () => {
    expect(prefilter({ title: 'איש/אשת תמיכה טכנית', company: 'x', location: '' }, prefs)).toEqual({ pass: false, reason: 'role type disabled: support' });
    expect(prefilter({ title: 'Tier 1/2 Support Developer', company: 'x', location: '' }, prefs)).toEqual({ pass: false, reason: 'role type disabled: support' });
  });

  it("never excludes a keyword an enabled role type uses, or a search-only role type's keywords", () => {
    expect(disabledRoleKeywords(prefs.roleTypes).map(([k]) => k)).not.toContain('developer');
    expect(disabledRoleKeywords(prefs.roleTypes).map(([k]) => k)).not.toContain('junior');
    expect(prefilter({ title: 'Junior Full Stack Developer', company: 'x', location: '' }, prefs).pass).toBe(true);
  });
});

describe('discover without a profile, score after approval; refilter on save', () => {
  const db = openDb(':memory:');
  const app = buildApp(db);
  const repo = new Repo(db);
  const byTitle = (t: string) => repo.listJobs({ q: t }).items[0]!;

  it('discovery still runs without an approved profile; scoring waits instead of failing the run', async () => {
    expect(fs.existsSync(profilePath())).toBe(false);
    startRun(db, 'drushim', 'full');
    await waitIdle();
    const run = repo.listRuns(1)[0] as unknown as { status: string; stats: Record<string, number> };
    expect(run.status).toBe('done');
    expect(run.stats.inserted).toBe(2);
    expect(run.stats.waitingForProfile).toBeGreaterThan(0);
    expect(byTitle('Full Stack').status).toBe('discovered');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().waitingForScore).toBeGreaterThan(0);
  });

  it('approving the profile starts the scoring by itself', async () => {
    const profile = { contact: { name: { he: 'דנה', en: 'Dana Test' }, city: {} }, gender: 'female', skills: [{ id: 'skill.react', name: 'React' }] };
    const r = await app.inject({ method: 'PUT', url: '/api/profile', payload: { profile, target: 'profile' } });
    expect(r.json().scoring).toMatchObject({ sites: ['drushim'] });
    await waitIdle();
    expect(byTitle('Full Stack').status).toBe('scored');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().waitingForScore).toBe(0);
  });

  it('saving Preferences re-runs the prefilter over existing jobs (both ways), without searching again', async () => {
    const prefs = loadPrefs();
    const support = prefs.roleTypes.find((x) => x.id === 'support')!;
    expect(byTitle('תמיכה').status).not.toMatch(/^skipped/);

    support.enabled = false;
    const off = (await app.inject({ method: 'PUT', url: '/api/preferences', payload: { preferences: prefs } })).json();
    expect(off.refilter).toMatchObject({ newlySkipped: 1 });
    expect(byTitle('תמיכה')).toMatchObject({ status: 'skipped', statusReason: 'prefilter: role type disabled: support' });
    expect(repo.listJobs({ hideSkipped: true }).items.map((j) => j.title)).toEqual(['Full Stack Developer']);

    support.enabled = true;
    const on = (await app.inject({ method: 'PUT', url: '/api/preferences', payload: { preferences: prefs } })).json();
    expect(on.refilter).toMatchObject({ restored: 1 });
    expect(byTitle('תמיכה').status).toBe('scored'); // its score is still current
    expect(repo.listRuns(10)).toHaveLength(2); // no new search run
  });
});
