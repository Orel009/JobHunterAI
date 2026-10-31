/**
 * Structured diff between the current profile and a fresh CV extraction, applied change by change.
 * USER-OWNED data is never part of a diff: gender, blockedSkills (removed skills stay removed), declaredExperience,
 * skill levels, aliases, skill↔role links, locked dates, and a month-precise date you added where the CV only has a year.
 */
import { normalizeText } from '../core/text.js';
import { skillKey } from './facts.js';
import type { Profile } from './schema.js';

type Role = Profile['experience'][number];
type Edu = Profile['education'][number];
type Skill = Profile['skills'][number];

export type DiffOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'setRole'; roleId: string; field: 'title' | 'company' | 'start' | 'end' | 'highlights' | 'kind'; value: unknown }
  | { op: 'addRole'; role: Role }
  | { op: 'removeRole'; roleId: string }
  | { op: 'setEdu'; eduId: string; field: 'institution' | 'degree' | 'field' | 'start' | 'end'; value: unknown }
  | { op: 'addEdu'; edu: Edu }
  | { op: 'removeEdu'; eduId: string }
  | { op: 'addSkill'; skill: Skill }
  | { op: 'removeSkill'; skillId: string }
  | { op: 'addLanguage'; language: Profile['languages'][number] }
  | { op: 'addLink'; link: Profile['links'][number] };

export interface DiffEntry {
  id: string;
  section: 'contact' | 'summary' | 'roles' | 'education' | 'skills' | 'languages' | 'links';
  kind: 'added' | 'changed' | 'removed';
  label: string;
  before: unknown;
  after: unknown;
  /** additions and date fixes — what "accept all safe changes" takes */
  safe: boolean;
  change: DiffOp;
}

const n = (s: string | null | undefined) => normalizeText(s ?? '');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const biText = (b: { he: string | null; en: string | null }) => [b.en, b.he].filter(Boolean).join(' / ');
const roleKey = (r: Role) => [n(r.company.en), n(r.company.he)].filter(Boolean);
const eduKey = (e: Edu) => [n(e.institution.en), n(e.institution.he)].filter(Boolean);
const overlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => x && y && (x === y || x.includes(y) || y.includes(x))));

/** A user's month-precise date beats a year-only CV date in the same year. */
const keepsUserPrecision = (cur: string | null, inc: string | null) => !!cur && !!inc && /^\d{4}-\d{2}$/.test(cur) && /^\d{4}$/.test(inc) && cur.startsWith(inc);

export function diffProfiles(current: Profile, incoming: Profile): DiffEntry[] {
  const out: DiffEntry[] = [];
  let seq = 0;
  const add = (e: Omit<DiffEntry, 'id'>) => out.push({ ...e, id: `d${++seq}` });

  // contact (gender is user-owned: never diffed)
  const contact: Array<[string[], string, unknown, unknown]> = [
    [['contact', 'name', 'he'], 'name (he)', current.contact.name.he, incoming.contact.name.he],
    [['contact', 'name', 'en'], 'name (en)', current.contact.name.en, incoming.contact.name.en],
    [['contact', 'email'], 'email', current.contact.email, incoming.contact.email],
    [['contact', 'phone'], 'phone', current.contact.phone, incoming.contact.phone],
    [['contact', 'city', 'he'], 'city (he)', current.contact.city.he, incoming.contact.city.he],
    [['contact', 'city', 'en'], 'city (en)', current.contact.city.en, incoming.contact.city.en],
  ];
  for (const [path, label, before, after] of contact) {
    if (after && !same(before, after) && !String(after).startsWith('CONFLICT')) add({ section: 'contact', kind: before ? 'changed' : 'added', label, before, after, safe: !before, change: { op: 'set', path, value: after } });
  }
  for (const l of ['he', 'en'] as const) {
    const before = current.summary[l];
    const after = incoming.summary[l];
    if (after && !same(before, after)) add({ section: 'summary', kind: before ? 'changed' : 'added', label: `summary (${l})`, before, after, safe: !before, change: { op: 'set', path: ['summary', l], value: after } });
  }

  // roles
  const matchedCur = new Set<string>();
  for (const inc of incoming.experience) {
    const cur = current.experience.find((r) => !matchedCur.has(r.id) && overlap(roleKey(r), roleKey(inc)));
    if (!cur) {
      add({ section: 'roles', kind: 'added', label: `${biText(inc.title)} @ ${biText(inc.company)}`, before: null, after: inc, safe: true, change: { op: 'addRole', role: inc } });
      continue;
    }
    matchedCur.add(cur.id);
    const label = `${biText(cur.title)} @ ${biText(cur.company)}`;
    for (const field of ['title', 'company'] as const) {
      const merged = { he: inc[field].he ?? cur[field].he, en: inc[field].en ?? cur[field].en };
      if (!same(cur[field], merged)) add({ section: 'roles', kind: 'changed', label: `${label}: ${field}`, before: cur[field], after: merged, safe: false, change: { op: 'setRole', roleId: cur.id, field, value: merged } });
    }
    if (!cur.datesLocked) {
      for (const field of ['start', 'end'] as const) {
        const a = inc[field];
        if (a && !String(a).startsWith('CONFLICT') && !same(cur[field], a) && !keepsUserPrecision(cur[field], a)) {
          add({ section: 'roles', kind: cur[field] ? 'changed' : 'added', label: `${label}: ${field} date`, before: cur[field], after: a, safe: true, change: { op: 'setRole', roleId: cur.id, field, value: a } });
        }
      }
    }
    const hl = { he: inc.highlights.he.length ? inc.highlights.he : cur.highlights.he, en: inc.highlights.en.length ? inc.highlights.en : cur.highlights.en };
    if (!same(cur.highlights, hl)) add({ section: 'roles', kind: 'changed', label: `${label}: highlights`, before: cur.highlights, after: hl, safe: false, change: { op: 'setRole', roleId: cur.id, field: 'highlights', value: hl } });
  }
  for (const cur of current.experience) {
    if (!matchedCur.has(cur.id)) add({ section: 'roles', kind: 'removed', label: `${biText(cur.title)} @ ${biText(cur.company)} (not in the new CV)`, before: cur, after: null, safe: false, change: { op: 'removeRole', roleId: cur.id } });
  }

  // education
  const matchedEdu = new Set<string>();
  for (const inc of incoming.education) {
    const cur = current.education.find((e) => !matchedEdu.has(e.id) && overlap(eduKey(e), eduKey(inc)));
    if (!cur) {
      add({ section: 'education', kind: 'added', label: biText(inc.institution), before: null, after: inc, safe: true, change: { op: 'addEdu', edu: inc } });
      continue;
    }
    matchedEdu.add(cur.id);
    for (const field of ['degree', 'field'] as const) {
      const merged = { he: inc[field].he ?? cur[field].he, en: inc[field].en ?? cur[field].en };
      if (!same(cur[field], merged)) add({ section: 'education', kind: 'changed', label: `${biText(cur.institution)}: ${field}`, before: cur[field], after: merged, safe: false, change: { op: 'setEdu', eduId: cur.id, field, value: merged } });
    }
    if (!cur.datesLocked) {
      for (const field of ['start', 'end'] as const) {
        const a = inc[field];
        if (a && !String(a).startsWith('CONFLICT') && !same(cur[field], a) && !keepsUserPrecision(cur[field], a)) {
          add({ section: 'education', kind: cur[field] ? 'changed' : 'added', label: `${biText(cur.institution)}: ${field} date`, before: cur[field], after: a, safe: true, change: { op: 'setEdu', eduId: cur.id, field, value: a } });
        }
      }
    }
  }
  for (const cur of current.education) {
    if (!matchedEdu.has(cur.id)) add({ section: 'education', kind: 'removed', label: `${biText(cur.institution)} (not in the new CV)`, before: cur, after: null, safe: false, change: { op: 'removeEdu', eduId: cur.id } });
  }

  // skills: by name/alias key; blocked skills never come back; levels/aliases/links are user-owned
  const keysOf = (s: Skill) => [s.name, ...s.aliases].map(skillKey);
  const blocked = new Set(current.blockedSkills.map(skillKey));
  const curKeys = new Set(current.skills.flatMap(keysOf));
  const incKeys = new Set(incoming.skills.flatMap(keysOf));
  for (const s of incoming.skills) {
    if (keysOf(s).some((k) => curKeys.has(k) || blocked.has(k))) continue;
    add({ section: 'skills', kind: 'added', label: s.name, before: null, after: s.name, safe: true, change: { op: 'addSkill', skill: { ...s, level: 'strong' } } });
  }
  for (const s of current.skills) {
    if (!keysOf(s).some((k) => incKeys.has(k))) add({ section: 'skills', kind: 'removed', label: `${s.name} (not in the new CV)`, before: s.name, after: null, safe: false, change: { op: 'removeSkill', skillId: s.id } });
  }

  // languages, links (additions only)
  const curLang = new Set(current.languages.flatMap((l) => [n(l.name.en), n(l.name.he)]).filter(Boolean));
  for (const l of incoming.languages) {
    if (![n(l.name.en), n(l.name.he)].some((x) => x && curLang.has(x))) add({ section: 'languages', kind: 'added', label: biText(l.name), before: null, after: l, safe: true, change: { op: 'addLanguage', language: l } });
  }
  const curUrls = new Set(current.links.map((l) => l.url.toLowerCase().replace(/\/+$/, '')));
  for (const l of incoming.links) {
    if (!curUrls.has(l.url.toLowerCase().replace(/\/+$/, ''))) add({ section: 'links', kind: 'added', label: l.url, before: null, after: l, safe: true, change: { op: 'addLink', link: l } });
  }
  return out;
}

const uniqueId = (base: string, taken: Set<string>) => {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
};

/** Applies the accepted changes to a copy of the current profile. User-owned fields are carried over untouched. */
export function applyDiff(current: Profile, entries: DiffEntry[], acceptedIds: string[]): Profile {
  const p = JSON.parse(JSON.stringify(current)) as Profile;
  const ids = () => new Set([...p.experience.map((r) => r.id), ...p.education.map((e) => e.id), ...p.skills.map((s) => s.id), ...p.languages.map((l) => l.id), ...p.links.map((l) => l.id)]);
  for (const e of entries.filter((x) => acceptedIds.includes(x.id))) {
    const c = e.change;
    switch (c.op) {
      case 'set': {
        let o = p as unknown as Record<string, unknown>;
        for (const k of c.path.slice(0, -1)) o = o[k] as Record<string, unknown>;
        o[c.path.at(-1)!] = c.value;
        break;
      }
      case 'setRole': {
        const r = p.experience.find((x) => x.id === c.roleId);
        if (r) (r as Record<string, unknown>)[c.field] = c.value;
        break;
      }
      case 'addRole': {
        // a new role brings no skill links: linking skills to roles is user-owned
        p.experience.push({ ...c.role, id: uniqueId(c.role.id, ids()), skills: [], datesLocked: false });
        break;
      }
      case 'removeRole':
        p.experience = p.experience.filter((x) => x.id !== c.roleId);
        break;
      case 'setEdu': {
        const ed = p.education.find((x) => x.id === c.eduId);
        if (ed) (ed as Record<string, unknown>)[c.field] = c.value;
        break;
      }
      case 'addEdu':
        p.education.push({ ...c.edu, id: uniqueId(c.edu.id, ids()), datesLocked: false });
        break;
      case 'removeEdu':
        p.education = p.education.filter((x) => x.id !== c.eduId);
        break;
      case 'addSkill':
        p.skills.push({ ...c.skill, id: uniqueId(c.skill.id, ids()), level: 'strong' });
        break;
      case 'removeSkill':
        p.skills = p.skills.filter((x) => x.id !== c.skillId);
        for (const r of p.experience) r.skills = r.skills.filter((x) => x !== c.skillId);
        break;
      case 'addLanguage':
        p.languages.push({ ...c.language, id: uniqueId(c.language.id, ids()) });
        break;
      case 'addLink':
        p.links.push({ ...c.link, id: uniqueId(c.link.id, ids()) });
        break;
    }
  }
  return p;
}

export const safeIds = (entries: DiffEntry[]) => entries.filter((e) => e.safe).map((e) => e.id);
