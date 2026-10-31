import { describe, expect, it, vi } from 'vitest';
import { prefilter, primaryRole, rolesMatchingTitle } from '../src/core/prefilter.js';
import { activeRoleTypes, DEFAULT_SENIORITY_EXCLUDES, PrefsSchema, searchPlan } from '../src/core/prefs.js';
import { experienceCategory, rankJob } from '../src/core/rank.js';
import { resolveField, type ResolveDeps } from '../src/apply/resolve.js';
import { readiness } from '../src/apply/plan.js';
import { skillYears } from '../src/profile/facts.js';
import { ProfileSchema } from '../src/profile/schema.js';
import type { FormField } from '../src/apply/types.js';

const prefs = PrefsSchema.parse({
  roleTypes: [
    { id: 'fullstack', tier: 1, queries: ['Full Stack Developer', 'מפתח פולסטאק'], titleKeywords: ['full stack', 'fullstack', 'פולסטאק'] },
    { id: 'backend', tier: 1, queries: ['Backend Developer', 'Full Stack Developer'], titleKeywords: ['backend', '.NET', 'Node.js'] },
    { id: 'automation', tier: 2, queries: ['QA Automation'], titleKeywords: ['automation', 'אוטומציה'] },
    { id: 'support', tier: 3, queries: ['תמיכה טכנית'], titleKeywords: ['תמיכה טכנית', 'support'] },
    { id: 'off', tier: 2, enabled: false, queries: ['Data Engineer'], titleKeywords: ['data'] },
  ],
  filters: { excludeTitleKeywords: ['Java'] },
});
const j = (title: string) => ({ title, company: 'acme', location: '' });

describe('prefilter: whole words, case-insensitive', () => {
  it('excluding "Java" does NOT exclude "JavaScript"', () => {
    expect(prefilter(j('JavaScript Full Stack Developer'), prefs).pass).toBe(true);
    expect(prefilter(j('Java Backend Developer'), prefs).reason).toMatch(/excluded title keyword: "Java"/);
  });
  it('default seniority list (Senior, Sr, Lead, Staff, בכיר/ה, ראש צוות, …)', () => {
    expect(DEFAULT_SENIORITY_EXCLUDES).toContain('Tech Lead');
    expect(prefilter(j('SENIOR Full Stack Developer'), prefs).reason).toMatch(/seniority/);
    expect(prefilter(j('Sr. Backend Developer'), prefs).reason).toMatch(/seniority: "Sr"/);
    expect(prefilter(j('Staff Engineer, Backend'), prefs).pass).toBe(false);
    expect(prefilter(j('מפתחת Full Stack בכירה'), prefs).pass).toBe(false);
    expect(prefilter(j('לראש צוות Backend'), prefs).pass).toBe(false);
    expect(prefilter(j('Full Stack Developer, Leading fintech'), prefs).pass).toBe(true); // "Lead" ≠ "Leading"
    expect(prefilter(j('Backend Developer - Staffing company'), prefs).pass).toBe(true); // "Staff" ≠ "Staffing"
  });
  it('include keywords come from enabled role types', () => {
    expect(prefilter(j('QA Automation Engineer'), prefs).pass).toBe(true);
    expect(prefilter(j('Data Analyst'), prefs).reason).toBe('no include keyword in title'); // role disabled
  });
});

describe('role types', () => {
  it('search plan: shared queries searched once, tagged with every role', () => {
    const plan = searchPlan(prefs);
    expect(plan.find((p) => p.query === 'Full Stack Developer')?.roleIds).toEqual(['fullstack', 'backend']);
    expect(plan.some((p) => p.query === 'Data Engineer')).toBe(false);
    expect(activeRoleTypes(prefs)).toHaveLength(4);
  });
  it('primary role prefers role types that found the job AND match its title', () => {
    expect(primaryRole({ title: 'Node.js Backend & Automation Developer', roleTypes: ['automation'] }, prefs)?.id).toBe('automation');
    expect(primaryRole({ title: 'Node.js Backend & Automation Developer', roleTypes: ['automation', 'backend'] }, prefs)?.id).toBe('backend');
  });
  it('primary role: best tier among title matches, else among the roles that found it', () => {
    expect(primaryRole({ title: 'QA Automation Engineer', roleTypes: ['fullstack'] }, prefs)?.id).toBe('automation');
    expect(primaryRole({ title: 'Software Engineer', roleTypes: ['support', 'automation'] }, prefs)?.id).toBe('automation');
    expect(rolesMatchingTitle('Node.js Backend Developer', activeRoleTypes(prefs)).map((r) => r.id)).toEqual(['backend']);
  });
  it('legacy queries become one tier-1 role type', () => {
    expect(activeRoleTypes(PrefsSchema.parse({ queries: { titles: ['Full Stack'] } }))).toMatchObject([{ id: 'default', tier: 1 }]);
  });
});

describe('ranking', () => {
  const R = PrefsSchema.parse({}).ranking;
  it('experience categories', () => {
    expect(experienceCategory({ requiredYears: 0, juniorText: null })).toBe('junior');
    expect(experienceCategory({ requiredYears: null, juniorText: 'בוגרי קורס' })).toBe('junior');
    expect(experienceCategory({ requiredYears: 2, juniorText: null })).toBe('years2');
    expect(experienceCategory({ requiredYears: 3, juniorText: 'junior' })).toBe('years3'); // stated years win
    expect(experienceCategory({ requiredYears: null, juniorText: null, seniority: 'junior' })).toBe('junior');
    expect(experienceCategory({ requiredYears: null, juniorText: null })).toBe('unknown');
  });
  it('rank = score + experience + tier (defaults +15/+5/-10/0 and +5/0/-10)', () => {
    expect(rankJob({ score: 70, requiredYears: 1, juniorText: null, tier: 1 }, R)).toMatchObject({ rank: 90, experience: 15, tier: 5 });
    expect(rankJob({ score: 70, requiredYears: 2, juniorText: null, tier: 2 }, R)).toMatchObject({ rank: 75 });
    expect(rankJob({ score: 80, requiredYears: 3, juniorText: null, tier: 3 }, R)).toMatchObject({ rank: 60 });
    expect(rankJob({ score: 60, requiredYears: null, juniorText: null, tier: null }, R)).toMatchObject({ rank: 60, experience: 0, tier: 0 });
    expect(rankJob({ score: null, requiredYears: 1, juniorText: null, tier: 1 }, R).rank).toBeNull();
  });
  it('weights are configurable', () => {
    const custom = PrefsSchema.parse({ ranking: { experienceBoost: { junior: 30 }, tierBoost: { tier1: 0 } } }).ranking;
    expect(rankJob({ score: 50, requiredYears: 0, juniorText: null, tier: 1 }, custom).rank).toBe(80);
  });
});

// ---------- years: work roles only + declaredExperience ----------
const NOW = new Date('2026-10-31T00:00:00Z');
const profile = ProfileSchema.parse({
  contact: { name: {}, city: {} },
  experience: [
    { id: 'exp.work', kind: 'work', company: {}, title: {}, start: '2024-01', end: '2025-12', skills: ['skill.react'] },
    { id: 'exp.proj', kind: 'project', company: {}, title: {}, start: '2020-01', end: '2023-12', skills: ['skill.react', 'skill.vue'] },
  ],
  skills: [{ id: 'skill.react', name: 'React' }, { id: 'skill.vue', name: 'Vue' }],
  declaredExperience: { totalDevYears: 2, basis: 'Konimbo web development (2024–2025) + Matrix (2025–present)' },
});
const q = (label: string, type: FormField['type'] = 'yes_no'): FormField => ({ key: 'k', label, type, required: true });
const deps = (kind: 'general' | 'technology' | 'unsure', p = profile): ResolveDeps => ({
  profile: p,
  bank: { byKey: () => null, active: () => [] },
  matchBank: async () => ({ entryId: null, confidence: 0 }),
  draft: vi.fn(),
  classifyYears: vi.fn(async () => ({ kind })),
  minConfidence: 0.85,
  job: { title: 'x', text: '', language: 'he' },
  now: NOW,
});

describe('years of experience', () => {
  it('only kind=work roles count (projects never do)', () => {
    expect(skillYears(profile, 'skill.react', NOW)).toMatchObject({ years: 2, from: ['exp.work'] });
    expect(skillYears(profile, 'skill.vue', NOW).years).toBeNull();
  });

  it('general statement ≤ declared → yes, with the basis as provenance', async () => {
    const r = await resolveField(q('האם יש לך לפחות שנתיים ניסיון בפיתוח תוכנה?'), deps('general'));
    expect(r).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'declared_experience', ref: 'declared.totalDevYears' } });
    expect(r.provenance.detail).toContain('Konimbo web development');
  });

  it('general statement > declared → no → the application is blocked (skipped_screening)', async () => {
    const r = await resolveField(q('Do you have 3+ years of experience as a software developer?'), deps('general'));
    expect(r).toMatchObject({ status: 'resolved', value: 'no', provenance: { source: 'declared_experience' } });
    expect(readiness([r])).toBe('blocked_no');
  });

  it('general count question answers the declared number', async () => {
    expect(await resolveField(q('כמה שנות ניסיון יש לך בפיתוח?', 'number'), deps('general'))).toMatchObject({ value: '2' });
  });

  it('technology statement never uses declaredExperience', async () => {
    const r = await resolveField(q('Do you have 2 years of experience with React?'), deps('technology'));
    expect(r).toMatchObject({ value: 'yes', provenance: { source: 'skill_years', ref: 'skill.react' } });
    // Vue only appears on a project → no work years → pending (not declared 2y)
    expect(await resolveField(q('Do you have 2 years of experience with Vue?'), deps('technology'))).toMatchObject({ status: 'pending' });
  });

  it('unsure classification → pending', async () => {
    expect(await resolveField(q('האם יש לך 2 שנות ניסיון בתחום?'), deps('unsure'))).toMatchObject({ status: 'pending', reason: expect.stringMatching(/unclear/) });
  });

  it('"general" that names a skill → pending (never mixes the two)', async () => {
    expect(await resolveField(q('Do you have 2 years of development experience with React?'), deps('general'))).toMatchObject({ status: 'pending' });
  });

  it('no declaredExperience → general statements stay pending', async () => {
    const p = ProfileSchema.parse({ ...profile, declaredExperience: null });
    expect(await resolveField(q('האם יש לך שנתיים ניסיון בפיתוח?'), deps('general', p))).toMatchObject({ status: 'pending' });
  });
});
