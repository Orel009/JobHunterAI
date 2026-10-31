import { describe, expect, it, vi } from 'vitest';
import { prefilter, primaryRole, rankTier, rolesMatchingTitle, scoringRole } from '../src/core/prefilter.js';
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
    { id: 'junior', tier: 1, searchOnly: true, queries: ['Junior Developer'], titleKeywords: ['junior'] },
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
    expect(activeRoleTypes(prefs)).toHaveLength(5);
  });
  it('primary role = best tier among role types matching the title (whoever found it)', () => {
    expect(primaryRole({ title: 'Node.js Backend & Automation Developer', roleTypes: ['automation'] }, prefs)?.id).toBe('backend');
    expect(primaryRole({ title: 'QA Automation Engineer', roleTypes: ['fullstack'] }, prefs)?.id).toBe('automation');
  });
  it('no title match → no role, ranked as tier 3; search-only roles never decide', () => {
    expect(primaryRole({ title: 'Software Engineer', roleTypes: ['support', 'automation'] }, prefs)).toBeNull();
    expect(rankTier(primaryRole({ title: 'Junior IT Support Technician', roleTypes: ['junior'] }, prefs))).toBe(3);
    expect(primaryRole({ title: 'Junior Full Stack Developer', roleTypes: ['junior'] }, prefs)?.id).toBe('fullstack');
    expect(scoringRole({ title: 'Software Engineer', roleTypes: ['support', 'automation'] }, prefs)?.id).toBe('automation');
  });
  it('search-only title keywords do not count as include keywords', () => {
    expect(prefilter(j('Junior Accountant'), prefs).reason).toBe('no include keyword in title');
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
  it('rank = score + experience + tier (defaults +15/+5/-10/0 and +5/0/-25)', () => {
    expect(rankJob({ score: 70, requiredYears: 1, juniorText: null, tier: 1 }, R)).toMatchObject({ rank: 90, experience: 15, tier: 5 });
    expect(rankJob({ score: 70, requiredYears: 2, juniorText: null, tier: 2 }, R)).toMatchObject({ rank: 75 });
    expect(rankJob({ score: 80, requiredYears: 3, juniorText: null, tier: 3 }, R)).toMatchObject({ rank: 45 });
    expect(rankJob({ score: 60, requiredYears: null, juniorText: null, tier: null }, R)).toMatchObject({ rank: 60, experience: 0, tier: 0 });
    expect(rankJob({ score: null, requiredYears: 1, juniorText: null, tier: 1 }, R).rank).toBeNull();
  });
  it('tier 3 ranks on min(score, devContentScore)', () => {
    expect(rankJob({ score: 95, devContentScore: 10, requiredYears: 0, juniorText: null, tier: 3 }, R)).toMatchObject({ rank: 0, score: 10, rawScore: 95 });
    expect(rankJob({ score: 70, devContentScore: 90, requiredYears: null, juniorText: null, tier: 3 }, R).rank).toBe(45);
    expect(rankJob({ score: 95, devContentScore: 10, requiredYears: null, juniorText: null, tier: 1 }, R).rank).toBe(100); // only tier 3
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
  declaredExperience: { totalDevYears: 2, basis: 'Acme web development (2024–2025) + Globex (2025–present)' },
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
    expect(r.provenance.detail).toContain('Acme web development');
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

describe('locations: city or the site region field', () => {
  const p = PrefsSchema.parse({ locations: ['חיפה', 'השרון', 'תל אביב'], filters: { remoteKeywords: ['remote', 'היברידי'] } });
  const job = (location: string, regions: string[] = []) => ({ title: 'x', company: 'c', location, regions });
  it('matches the city, the region field (both directions) or remote words', () => {
    expect(prefilter(job('חיפה'), p).pass).toBe(true);
    expect(prefilter(job('תל אביב יפו'), p).pass).toBe(true);
    expect(prefilter(job('קריית ביאליק', ['חיפה / קריות']), p).pass).toBe(true);
    expect(prefilter(job('צור יגאל', ['שרון']), p).pass).toBe(true); // "השרון" ↔ "שרון"
    expect(prefilter(job('אילת', ['אילת', 'דרום']), p).reason).toBe('location: אילת (regions: אילת, דרום)');
    expect(prefilter(job('Remote'), p).pass).toBe(true);
  });
});

describe('title excludes for support / courses', () => {
  const p = PrefsSchema.parse({
    filters: { includeTitleKeywords: ['תמיכה טכנית', 'developer', 'מפתח'], excludeTitleKeywords: ['נציג', 'נציגת', 'נציגי', 'נציג/ה', 'helpdesk', 'help desk', 'מחשוב', 'מוקד', 'call center', 'שירות לקוחות', 'הכשרה', 'קורס', 'הכשרה והשמה', 'מסלול הכשרה', 'הסבה', 'bootcamp', 'course', 'training program'] },
  });
  it.each([
    ['נציג/ת תמיכה טכנית', false],
    ['נציגי/ות תמיכה טכנית', false],
    ['תמיכה טכנית ומחשוב', false],
    ['Helpdesk Developer', false],
    ['AI software engineer - הכשרה והשמה למשרות פיתוח', false],
    ['מסלול הכשרה למפתחים', false],
    ['הכשרה+עבודה כמפתח/ת אינפורמטיקה', false],
    ['Full Stack Developer course', false],
    ['מפתח/ת תוכנה', true],
    ['תמיכה טכנית אפליקטיבית למפתחים', true],
  ])('%s → pass=%s', (title, pass) => {
    expect(prefilter({ title, company: 'c', location: '' }, p).pass).toBe(pass);
  });
});
