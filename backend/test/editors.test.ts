import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../src/db/index.js';
import { buildApp } from '../src/server/app.js';
import { draftPath, validateProfile, writeProfileFile } from '../src/profile/store.js';
import path from 'node:path';
import { config } from '../src/config.js';
import { candidateGender, profilePath } from '../src/profile/facts.js';

const app = buildApp(openDb(':memory:'));
const clean = () => {
  for (const f of [profilePath(), draftPath()]) if (fs.existsSync(f)) fs.rmSync(f);
};
beforeAll(clean);
afterAll(clean);

const minimal = { contact: { name: { he: 'דנה', en: 'Dana' }, city: {} }, gender: 'female', skills: [{ id: 'skill.react', name: 'React' }] };

describe('profile editor API', () => {
  it('validateProfile reports schema problems and unresolved CONFLICT values', () => {
    expect(validateProfile(minimal).ok).toBe(true);
    const bad = validateProfile({ ...minimal, experience: [{ id: 'e', company: {}, title: {}, start: 'CONFLICT he=2020 en=2021', end: '2022-13' }] });
    expect(bad.ok).toBe(false);
    expect(bad.issues.join('\n')).toMatch(/unresolved CONFLICT/);
    expect(bad.issues.join('\n')).toMatch(/experience\.0\.end/);
  });

  it('no profile → source none', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/profile' });
    expect(r.json()).toMatchObject({ source: 'none', profile: null });
  });

  it('a draft can be saved with issues; profile.json cannot', async () => {
    const broken = { ...minimal, experience: [{ id: 'e', company: {}, title: {}, start: '2020-99', end: null }] };
    const d = await app.inject({ method: 'PUT', url: '/api/profile', payload: { profile: broken, target: 'draft' } });
    expect(d.statusCode).toBe(200);
    expect(d.json().validation.ok).toBe(false);
    const p = await app.inject({ method: 'PUT', url: '/api/profile', payload: { profile: broken, target: 'profile' } });
    expect(p.statusCode).toBe(400);
    expect(fs.existsSync(profilePath())).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/profile/promote' })).statusCode).toBe(400);
  });

  it('a valid draft is promoted to profile.json and then edited in place', async () => {
    await app.inject({ method: 'PUT', url: '/api/profile', payload: { profile: minimal, target: 'draft' } });
    expect((await app.inject({ method: 'POST', url: '/api/profile/promote' })).statusCode).toBe(200);
    const g = (await app.inject({ method: 'GET', url: '/api/profile' })).json();
    expect(g).toMatchObject({ source: 'profile', validation: { ok: true } });
    expect(g.derived.skillYears['skill.react']).toMatchObject({ years: null });
    const s = await app.inject({ method: 'PUT', url: '/api/profile', payload: { profile: { ...minimal, gender: 'male' } } });
    expect(s.json()).toMatchObject({ ok: true, target: 'profile' });
    expect(JSON.parse(fs.readFileSync(profilePath(), 'utf8')).gender).toBe('male');
  });

  it('preferences are validated before saving', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/preferences', payload: { preferences: { maxRequiredYears: -1, roleTypes: [{ id: 'x', tier: 7 }] } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues.join('\n')).toMatch(/maxRequiredYears|tier/);
  });
});

describe('setup wizard', () => {
  const stateFile = () => path.join(config.dataDir, 'onboarding.json');
  const reset = () => {
    clean();
    if (fs.existsSync(stateFile())) fs.rmSync(stateFile());
  };
  beforeAll(reset);
  afterAll(reset);

  it('opens on a fresh installation, not when a profile or draft already exists', async () => {
    reset();
    expect((await app.inject({ method: 'GET', url: '/api/onboarding' })).json().needed).toBe(true);
    writeProfileFile(draftPath(), minimal); // an existing user's draft
    expect((await app.inject({ method: 'GET', url: '/api/onboarding' })).json().needed).toBe(false);
    reset();
  });

  it('name + gender from the wizard go into the draft; finish approves it and ends the wizard', async () => {
    reset();
    await app.inject({ method: 'PUT', url: '/api/onboarding', payload: { name: 'Maya Levi', gender: 'female', step: 1 } });
    expect(candidateGender()).toBe('female'); // before any profile exists
    writeProfileFile(draftPath(), { contact: { name: { he: null, en: 'M. L.' }, city: {} } }); // CV extraction result
    expect((await app.inject({ method: 'GET', url: '/api/onboarding' })).json().needed).toBe(true); // in progress
    await app.inject({ method: 'PUT', url: '/api/onboarding', payload: { name: 'Maya Levi', gender: 'female', step: 3 } });
    const draft = JSON.parse(fs.readFileSync(draftPath(), 'utf8'));
    expect(draft).toMatchObject({ gender: 'female', contact: { name: { en: 'Maya Levi' } } });
    const fin = await app.inject({ method: 'POST', url: '/api/onboarding/finish' });
    expect(fin.statusCode).toBe(200);
    expect(fs.existsSync(profilePath())).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/onboarding' })).json().needed).toBe(false);
    const qs = (await app.inject({ method: 'GET', url: '/api/onboarding/standard-questions' })).json() as Array<{ question: string }>;
    expect(qs.map((q) => q.question)).toContain('האם את מעוניינת במשרה מלאה?');
    reset();
  });
});
