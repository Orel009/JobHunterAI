import { describe, expect, it } from 'vitest';
import { applyDiff, diffProfiles, safeIds } from '../src/profile/diff.js';
import { ProfileSchema } from '../src/profile/schema.js';

const current = ProfileSchema.parse({
  gender: 'female',
  blockedSkills: ['Caddy'],
  declaredExperience: { totalDevYears: 2, basis: 'two jobs' },
  contact: { name: { en: 'Dana Levi' }, email: 'dana@example.com', city: { en: 'Haifa' } },
  experience: [
    { id: 'exp.acme', company: { en: 'Acme' }, title: { en: 'Developer' }, start: '2022-03', end: '2024', skills: ['skill.react'], datesLocked: false },
    { id: 'exp.beta', company: { en: 'Beta' }, title: { en: 'Engineer' }, start: '2020', end: '2021', skills: [], datesLocked: true },
    { id: 'exp.gone', company: { en: 'Gone Ltd' }, title: { en: 'Intern' }, start: '2019', end: '2019', skills: [] },
  ],
  skills: [
    { id: 'skill.react', name: 'React', aliases: ['React.js'], level: 'basic' },
    { id: 'skill.cobol', name: 'COBOL' },
  ],
});
const incoming = ProfileSchema.parse({
  contact: { name: { en: 'Dana Levi', he: 'דנה לוי' }, email: 'dana@example.com', phone: '050-0000000', city: { en: 'Haifa' } },
  experience: [
    { id: 'exp.acme', company: { en: 'Acme' }, title: { en: 'Developer' }, start: '2022', end: '2025', skills: ['skill.react', 'skill.vue'] },
    { id: 'exp.beta', company: { en: 'Beta' }, title: { en: 'Senior Engineer' }, start: '2018', end: '2021', skills: [] },
    { id: 'exp.new', company: { en: 'NewCo' }, title: { en: 'Developer' }, start: '2025', end: 'present', skills: ['skill.react'] },
  ],
  skills: [
    { id: 'skill.react', name: 'React 19' },
    { id: 'skill.vue', name: 'Vue' },
    { id: 'skill.caddy', name: 'Caddy' },
  ],
});
const entries = diffProfiles(current, incoming);
const find = (label: RegExp) => entries.find((e) => label.test(e.label));

describe('profile diff', () => {
  it('lists additions, changes and removals by section', () => {
    expect(find(/^name \(he\)$/)).toMatchObject({ kind: 'added', safe: true });
    expect(find(/^phone$/)).toMatchObject({ kind: 'added', safe: true });
    expect(find(/NewCo/)).toMatchObject({ section: 'roles', kind: 'added', safe: true });
    expect(find(/Gone Ltd/)).toMatchObject({ kind: 'removed', safe: false });
    expect(find(/Beta.*title/)).toMatchObject({ kind: 'changed', safe: false });
    expect(find(/^Vue$/)).toMatchObject({ section: 'skills', kind: 'added', safe: true });
    expect(find(/COBOL/)).toMatchObject({ kind: 'removed', safe: false });
  });

  it('date fixes are safe; month-precise dates you added are kept; locked dates are never proposed', () => {
    expect(find(/Acme.*end date/)).toMatchObject({ before: '2024', after: '2025', safe: true });
    expect(find(/Acme.*start date/)).toBeUndefined(); // 2022-03 (yours) vs 2022 (CV)
    expect(find(/Beta.*date/)).toBeUndefined(); // datesLocked
  });

  it('removed (blocked) skills never come back; known skills match by alias/version', () => {
    expect(find(/Caddy/)).toBeUndefined();
    expect(find(/React/)).toBeUndefined();
  });

  it('applying safe changes keeps every user-owned field', () => {
    const next = applyDiff(current, entries, safeIds(entries));
    expect(next.gender).toBe('female');
    expect(next.blockedSkills).toEqual(['Caddy']);
    expect(next.declaredExperience).toEqual({ totalDevYears: 2, basis: 'two jobs' });
    const react = next.skills.find((s) => s.id === 'skill.react')!;
    expect(react).toMatchObject({ level: 'basic', aliases: ['React.js'] });
    expect(next.experience.find((r) => r.id === 'exp.acme')).toMatchObject({ start: '2022-03', end: '2025', skills: ['skill.react'] });
    expect(next.experience.find((r) => r.id === 'exp.beta')).toMatchObject({ title: { en: 'Engineer' }, start: '2020' });
    expect(next.experience.some((r) => r.id === 'exp.gone')).toBe(true); // removal is not "safe"
    expect(next.experience.find((r) => r.company.en === 'NewCo')).toMatchObject({ skills: [] }); // links are yours to make
    expect(next.skills.map((s) => s.name)).toContain('Vue');
    expect(next.contact).toMatchObject({ phone: '050-0000000', name: { he: 'דנה לוי' } });
    expect(ProfileSchema.safeParse(next).success).toBe(true);
  });

  it('only accepted changes are applied', () => {
    const removal = find(/Gone Ltd/)!;
    const next = applyDiff(current, entries, [removal.id]);
    expect(next.experience.map((r) => r.id)).toEqual(['exp.acme', 'exp.beta']);
    expect(next.contact.phone).toBeNull();
  });
});
