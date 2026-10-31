import { describe, expect, it, vi } from 'vitest';
import { resolveField, withSynonymHint, type ResolveDeps } from '../src/apply/resolve.js';
import { questionKey } from '../src/apply/classify.js';
import type { BankEntry } from '../src/apply/bank.js';
import type { FormField } from '../src/apply/types.js';
import { prefilter, expandWithAliases } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { canonicalizeSkillMentions, profileForScoring, skillAliasGroups } from '../src/profile/facts.js';
import { normalizeText } from '../src/core/text.js';
import { ProfileSchema } from '../src/profile/schema.js';

const NOW = new Date('2026-10-31T00:00:00Z');
const profile = ProfileSchema.parse({
  contact: { name: { en: 'Test' }, city: {} },
  experience: [{ id: 'exp.acme', company: { en: 'Acme' }, title: { en: 'Developer' }, start: '2020-01', end: '2024-12', skills: ['skill.js', 'skill.oop', 'skill.python'] }],
  skills: [
    { id: 'skill.js', name: 'JavaScript', aliases: ['ES6+', 'ES6', 'JS'] },
    { id: 'skill.oop', name: 'Object-Oriented Programming', aliases: ['OOP'] },
    { id: 'skill.git', name: 'Git', aliases: ['GitHub'] },
    { id: 'skill.python', name: 'Python', level: 'basic' },
  ],
});

const entry = (id: number, question: string, answer: string): BankEntry => ({
  id, question, normKey: questionKey(question), answer, type: 'yes_no', options: null, language: 'he', status: 'active',
  usageCount: 0, source: 'user', createdAt: '', updatedAt: '', lastUsedAt: null,
});
function deps(bank: BankEntry[] = []) {
  const matchBank = vi.fn(async () => ({ entryId: null as number | null, confidence: 0 }));
  const draft = vi.fn(async () => ({ text: 'x', usedFactIds: ['exp.acme'], unanswerable: false, flaggedClaims: [] as string[] }));
  const d: ResolveDeps = {
    profile,
    bank: { byKey: (k) => bank.find((b) => b.normKey === k) ?? null, active: () => bank },
    matchBank,
    draft,
    minConfidence: 0.85,
    job: { title: 'Dev', text: '', language: 'he' },
    now: NOW,
  };
  return { d, matchBank, draft };
}
const q = (label: string, type: FormField['type'] = 'yes_no'): FormField => ({ key: 'k', label, type, required: true });

describe('skill level = basic', () => {
  it('never auto-answers a years statement, even when the dates would say yes', async () => {
    const { d } = deps();
    const r = await resolveField(q('האם יש לך לפחות שנתיים ניסיון ב-Python?'), d);
    expect(r.status).toBe('pending');
    expect(r.reason).toMatch(/basic-level skill \(Python\)/);
  });
  it('never auto-answers a years count question either', async () => {
    const { d } = deps();
    expect(await resolveField(q('How many years of experience do you have with Python?', 'number'), d)).toMatchObject({ status: 'pending' });
  });
  it('a statement mixing a strong and a basic skill also goes to pending', async () => {
    const { d } = deps();
    expect(await resolveField(q('Do you have 2+ years of experience with JavaScript and Python?'), d)).toMatchObject({ status: 'pending' });
  });
  it('strong skills on the same dated role still answer deterministically', async () => {
    const { d } = deps();
    expect(await resolveField(q('Do you have 2+ years of experience with JavaScript?'), d)).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'skill_years' } });
  });
  it('still counts for scoring (listed, marked basic)', () => {
    expect(profileForScoring(profile)).toMatch(/Skill: Python \[basic level\]/);
  });
});

describe('aliases are used for matching everywhere', () => {
  it('years statements: "ES6" and "OOP" resolve to the canonical skills', async () => {
    const { d } = deps();
    expect(await resolveField(q('האם יש לך לפחות 3 שנות ניסיון ב-ES6?'), d)).toMatchObject({ value: 'yes', provenance: { ref: 'skill.js' } });
    expect(await resolveField(q('Do you have 6 years of experience with OOP?'), d)).toMatchObject({ value: 'no', provenance: { ref: 'skill.oop' } });
  });

  it('answers bank: a JavaScript answer is reused for the ES6 wording, without the LLM', async () => {
    const { d, matchBank } = deps([entry(5, 'האם יש לך ניסיון ב-JavaScript?', 'כן')]);
    const r = await resolveField(q('האם יש לך ניסיון ב-ES6?'), d);
    expect(r).toMatchObject({ status: 'resolved', value: 'yes', provenance: { source: 'bank', ref: '5', detail: expect.stringContaining('synonyms') } });
    expect(matchBank).not.toHaveBeenCalled();
  });

  it('answers bank: the LLM matcher is told the synonyms', () => {
    expect(withSynonymHint('ניסיון עם GitHub?', profile)).toContain('Git = GitHub');
  });

  it('canonicalizes whole words only', () => {
    expect(canonicalizeSkillMentions(normalizeText('ניסיון ב-OOP וב-JS'), profile)).toBe('ניסיון ב object oriented programming וב javascript');
    expect(canonicalizeSkillMentions(normalizeText('JSON parsing'), profile)).toBe('json parsing');
  });

  it('prefilter: a skill keyword matches every spelling of that skill', () => {
    const prefs = PrefsSchema.parse({ filters: { includeTitleKeywords: ['JavaScript', 'Object-Oriented Programming'] } });
    const groups = skillAliasGroups(profile);
    expect(prefilter({ title: 'ES6 Developer', company: 'x', location: '' }, prefs, { aliasGroups: groups }).pass).toBe(true);
    expect(prefilter({ title: 'OOP Engineer', company: 'x', location: '' }, prefs, { aliasGroups: groups }).pass).toBe(true);
    expect(prefilter({ title: 'ES6 Developer', company: 'x', location: '' }, prefs).pass).toBe(false); // without profile aliases
    expect(expandWithAliases(['Kubernetes'], groups)).toEqual(['Kubernetes']);
  });

  it('scoring context lists the alternative spellings', () => {
    const ctx = profileForScoring(profile);
    expect(ctx).toContain('JavaScript (also written: ES6+, ES6, JS)');
    expect(ctx).toContain('Object-Oriented Programming (also written: OOP)');
  });
});
