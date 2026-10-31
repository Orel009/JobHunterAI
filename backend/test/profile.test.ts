import { describe, expect, it } from 'vitest';
import { itemsToText } from '../src/profile/pdf.js';
import { cleanLinks, dropUnsupportedMonth, foundIn, isDescriptivePhrase, mergeProfiles, normDate, splitSkill, uncoveredDateLines, verifyExtraction, type Extracted } from '../src/profile/merge.js';
import { findSkill, loadProfile, monthIndex, skillKey, skillYears, unionMonths } from '../src/profile/facts.js';
import { ProfileSchema } from '../src/profile/schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('pdf text rebuild', () => {
  it('inserts spaces between RTL word boxes and flips mirrored lone brackets', () => {
    const it = (str: string, x: number, w: number, dir = 'rtl') => ({ str, x, y: 100, w, h: 11, eol: false, dir });
    const text = itemsToText([it('סוכנים', 300, 30), it(')', 292, 3, 'ltr'), it('AI Agents', 242, 50, 'ltr'), it('(', 239, 3, 'ltr'), it('ואוטומציות', 180, 50)]);
    expect(text).toBe('סוכנים (AI Agents) ואוטומציות');
  });
  it('keeps touching boxes joined (".NET")', () => {
    expect(itemsToText([{ str: '.', x: 291.9, y: 1, w: 3.1, h: 11, eol: false }, { str: 'NET Core', x: 164.9, y: 1, w: 127.1, h: 11, eol: false }])).toBe('.NET Core');
  });
});

describe('verification against CV text', () => {
  const cv = 'Software Developer | ACME\n2025 – Present\nSkills: React.js, Node.js, CSS3/SCSS\nPractical Software Engineer | Example College\n2021 – 2024';
  it('foundIn: exact normalized substring or ≥80% token coverage', () => {
    expect(foundIn(cv, 'react.js')).toBe(true);
    expect(foundIn(cv, 'Kubernetes')).toBe(false);
  });
  it('dates: invented month precision is dropped', () => {
    expect(normDate('03/2021')).toBe('2021-03');
    expect(normDate('כיום')).toBe('present');
    expect(dropUnsupportedMonth(cv, '2025-01')).toBe('2025');
    expect(dropUnsupportedMonth('Jan 2025 – Present', '2025-01')).toBe('2025-01');
    expect(dropUnsupportedMonth('03/2021 - 2024', '2021-03')).toBe('2021-03');
  });
  it('drops facts that are not in the CV', () => {
    const x: Extracted = {
      name: 'Someone Else', city: null, summary: null,
      experience: [{ kind: 'work', company: 'ACME', title: 'Software Developer', start: '2025-01', end: 'present', skills: ['React.js', 'Kubernetes'], highlights: [] }],
      education: [], skills: [{ name: 'Node.js', statedYears: 5 }, { name: 'Go', statedYears: null }], languages: [],
    };
    const { clean, dropped } = verifyExtraction(x, cv, 'en');
    expect(clean.name).toBeNull();
    expect(clean.experience[0]!.start).toBe('2025');
    expect(clean.experience[0]!.skills).toEqual(['React.js']);
    expect(clean.skills).toEqual([{ name: 'Node.js', statedYears: null }]); // "5 years" not in text
    expect(dropped.map((d) => d.value)).toEqual(expect.arrayContaining(['Someone Else', 'Kubernetes', 'Go', '5']));
  });
  it('recall check finds dated lines nobody extracted', () => {
    const x: Extracted = { name: null, city: null, summary: null, experience: [{ kind: 'work', company: 'ACME', title: 'Software Developer', start: '2025', end: 'present', skills: [], highlights: [] }], education: [], skills: [], languages: [] };
    expect(uncoveredDateLines(cv, x)).toEqual(['2021 – 2024']);
  });
  it('splits compound skills, keeps short pairs, filters prose', () => {
    expect(splitSkill('Docker & Docker Compose')).toEqual(['Docker', 'Docker Compose']);
    expect(splitSkill('CSS3/SCSS')).toEqual(['CSS3', 'SCSS']);
    expect(splitSkill('UX/UI')).toEqual(['UX/UI']);
    expect(splitSkill('Multi-Provider LLMs (Claude, Gemini)')).toEqual(['Multi-Provider LLMs', 'Claude', 'Gemini']);
    expect(isDescriptivePhrase('risk gates')).toBe(true);
    expect(isDescriptivePhrase('Docker Compose')).toBe(false);
  });
  it('links: http(s) only, deduped', () => {
    expect(cleanLinks(['mailto:a@b.co', 'http://www.linkedin.com/in/x', 'https://linkedin.com/in/x/', 'https://github.com/x'])).toEqual(['https://linkedin.com/in/x/', 'https://github.com/x']);
  });
});

describe('merge: contradictions listed, never resolved', () => {
  const base: Extracted = { name: 'N', city: null, summary: null, experience: [], education: [], skills: [], languages: [] };
  it('date conflicts become CONFLICT values; year vs month in same year agree', () => {
    const he: Extracted = { ...base, experience: [{ kind: 'work', company: 'אקמה', title: 'מפתח', start: '2021', end: '2023', skills: [], highlights: [] }] };
    const en: Extracted = { ...base, experience: [{ kind: 'work', company: 'Acme', title: 'Developer', start: '2021-03', end: '2024', skills: [], highlights: [] }] };
    const { profile, conflicts } = mergeProfiles({ he, en, heText: '', enText: '', links: [] }, { experience: [{ he: 0, en: 0, titleMismatch: false, note: '' }], education: [] });
    expect(profile.experience[0]).toMatchObject({ id: 'exp.acme', start: '2021-03', end: 'CONFLICT he=2023 en=2024' });
    expect(conflicts.filter((c) => c.kind === 'contradiction')).toHaveLength(1);
  });
  it('contact conflicts from deterministic regex', () => {
    const { profile, conflicts } = mergeProfiles({ he: base, en: base, heText: 'x@a.com 050-1111111', enText: 'x@a.com 050-2222222', links: [] }, { experience: [], education: [] });
    expect(profile.contact.email).toBe('x@a.com');
    expect(profile.contact.phone).toMatch(/^CONFLICT/);
    expect(conflicts.some((c) => c.where === 'contact.phone')).toBe(true);
  });
  it('profile.json with unresolved CONFLICT values refuses to load', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-')), 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ contact: { name: {}, city: {}, phone: 'CONFLICT he=1 en=2' } }));
    expect(() => loadProfile(file)).toThrow(/unresolved conflicts/);
  });
});

describe('skill years', () => {
  it('union of intervals counts overlaps once', () => {
    expect(unionMonths([[0, 11], [6, 17], [30, 35]])).toBe(24);
  });
  it('year-only dates are conservative (start=Dec, end=Jan)', () => {
    expect(monthIndex('2021', 'start')).toBe(2021 * 12 + 11);
    expect(monthIndex('2024', 'end')).toBe(2024 * 12);
  });
  it('derived from roles listing the skill; stated wins; no dates → null', () => {
    const p = ProfileSchema.parse({
      contact: { name: {}, city: {} },
      experience: [
        { id: 'exp.a', company: {}, title: {}, start: '2020-01', end: '2021-12', skills: ['skill.react'] },
        { id: 'exp.b', company: {}, title: {}, start: null, end: null, skills: ['skill.go'] },
      ],
      skills: [{ id: 'skill.react', name: 'React' }, { id: 'skill.go', name: 'Go' }, { id: 'skill.k8s', name: 'Kubernetes', statedYears: 3 }],
    });
    expect(skillYears(p, 'skill.react')).toMatchObject({ years: 2, source: 'derived', from: ['exp.a'] });
    expect(skillYears(p, 'skill.go')).toMatchObject({ years: null });
    expect(skillYears(p, 'skill.k8s')).toMatchObject({ years: 3, source: 'stated' });
  });
  it('skill keys unify versions and suffixes', () => {
    expect(skillKey('React.js')).toBe(skillKey('React 19'));
    expect(skillKey('CSS3')).toBe('css');
    expect(skillKey('S3')).toBe('s3');
    const p = ProfileSchema.parse({ contact: { name: {}, city: {} }, skills: [{ id: 'skill.node', name: 'Node.js', aliases: ['NodeJS'] }] });
    expect(findSkill(p, 'node')?.id).toBe('skill.node');
    expect(findSkill(p, 'MSSQL')).toBeNull();
  });
});
