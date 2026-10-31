/**
 * Pure logic for profile:init: verify LLM-extracted CV facts against the CV text, merge the Hebrew and English
 * extractions, and list every contradiction without choosing a side.
 */
import { z } from 'zod';
import { normalizeText } from '../core/text.js';
import { skillKey } from './facts.js';
import type { Profile } from './schema.js';

export type Lang = 'he' | 'en';

// ---------- LLM extraction shape (one CV) ----------
export const ExtractSchema = z.object({
  name: z.string().nullable(),
  city: z.string().nullable(),
  summary: z.string().nullable(),
  experience: z.array(
    z.object({
      kind: z.enum(['work', 'military', 'volunteer', 'project', 'other']),
      company: z.string(),
      title: z.string(),
      start: z.string().nullable(),
      end: z.string().nullable(),
      skills: z.array(z.string()).max(30),
      highlights: z.array(z.string()).max(15),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      start: z.string().nullable(),
      end: z.string().nullable(),
    }),
  ),
  // caps stop degenerate repetition loops in constrained decoding (seen: "Docker, Caddy, Docker, …")
  skills: z.array(z.object({ name: z.string(), statedYears: z.number().nullable() })).max(80),
  languages: z.array(z.object({ name: z.string(), level: z.string().nullable() })),
});
export type Extracted = z.infer<typeof ExtractSchema>;

export const AlignSchema = z.object({
  experience: z.array(z.object({ he: z.number().int().nullable(), en: z.number().int().nullable(), titleMismatch: z.boolean(), note: z.string() })),
  education: z.array(z.object({ he: z.number().int().nullable(), en: z.number().int().nullable() })),
});
export type Alignment = z.infer<typeof AlignSchema>;

// ---------- verification ----------
const tokens = (s: string) => normalizeText(s).split(' ').filter((t) => t.length > 1);

/** True if `value` is supported by the CV text: exact (normalized) substring, or ≥80% token coverage for long text. */
export function foundIn(cvText: string, value: string | null | undefined): boolean {
  if (!value) return false;
  const hay = normalizeText(cvText);
  const v = normalizeText(value);
  if (!v) return false;
  if (hay.includes(v)) return true;
  const vt = tokens(value);
  if (vt.length < 4) return false;
  const set = new Set(hay.split(' '));
  return vt.filter((t) => set.has(t)).length / vt.length >= 0.8;
}

/** Normalizes CV date strings to YYYY / YYYY-MM / present; null when unparseable. */
export function normDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = d.trim();
  if (/^(present|current|now|today|כיום|היום|עד היום|הווה)$/i.test(s)) return 'present';
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.](\d{4})$/);
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`;
  m = s.match(/^(\d{4})$/);
  if (m) return m[1]!;
  return null;
}

const yearOk = (cvText: string, d: string | null) => d === null || d === 'present' || cvText.includes(d.slice(0, 4));

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** Keeps "YYYY-MM" only if the CV text shows that month for that year; otherwise "YYYY" (no invented precision). */
export function dropUnsupportedMonth(cvText: string, d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}$/.test(d)) return d;
  const [y, mm] = d.split('-') as [string, string];
  const m = Number(mm);
  const num = new RegExp(`(^|\\D)0?${m}\\s*[/.\\-]\\s*${y}(\\D|$)|(^|\\D)${y}\\s*[/.\\-]\\s*0?${m}(\\D|$)`);
  const name = new RegExp(`(${MONTHS_EN[m - 1]}[a-z]*\\.?|${MONTHS_HE[m - 1]})\\s*,?\\s*${y}`, 'i');
  return num.test(cvText) || name.test(cvText) ? d : y;
}

/**
 * Splits compound skill strings: "Docker & Docker Compose" → [Docker, Docker Compose], "CSS3/SCSS" → [CSS3, SCSS],
 * "LLMs (Claude, Gemini)" → [LLMs, Claude, Gemini]. Short pairs like "UX/UI" or "CI/CD" stay whole.
 */
export function splitSkill(s: string): string[] {
  let main = s.trim();
  let inner: string[] = [];
  const m = main.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m) {
    main = m[1]!;
    inner = m[2]!.split(',');
  }
  const parts = main
    .split(/\s+&\s+|\s+\/\s+|,\s*/)
    .flatMap((p) => (/^[^/\s]{3,}\/[^/\s]{3,}$/.test(p.trim()) ? p.split('/') : [p]));
  return [...new Set([...parts, ...inner].map((p) => p.trim()).filter((p) => p.length > 1))];
}

/**
 * Recall check: every CV line with a year range must be covered by an extracted entry (one of its names appears
 * on that line or the line before). Uncovered lines are reported as possibly missed.
 */
export function uncoveredDateLines(cvText: string, x: Extracted): string[] {
  const lines = cvText.split('\n');
  const names = [
    ...x.experience.flatMap((e) => [e.company, e.title]),
    ...x.education.flatMap((e) => [e.institution, e.degree ?? '']),
  ]
    .map((n) => normalizeText(n))
    .filter((n) => n.length > 2);
  return lines.filter((line, i) => {
    if (!/\b(19|20)\d{2}\s*[–-]\s*((19|20)\d{2}|present|כיום|היום)/i.test(line)) return false;
    const ctx = normalizeText(`${lines[i - 1] ?? ''} ${line}`);
    const ctxTokens = new Set(ctx.split(' '));
    const covered = (n: string) => {
      if (ctx.includes(n)) return true;
      const t = n.split(' ').filter((x) => x.length > 1);
      return t.length > 0 && t.filter((x) => ctxTokens.has(x)).length / t.length >= 0.6;
    };
    return !names.some(covered);
  });
}

export interface Dropped {
  lang: Lang;
  what: string;
  value: string;
}

/** Removes everything the CV text doesn't support; returns the cleaned extraction plus what was dropped. */
export function verifyExtraction(x: Extracted, cvText: string, lang: Lang): { clean: Extracted; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const keep = (what: string, value: string | null, ok: boolean) => {
    if (value && !ok) dropped.push({ lang, what, value });
    return ok ? value : null;
  };
  const clean: Extracted = {
    name: keep('name', x.name, foundIn(cvText, x.name)),
    city: keep('city', x.city, foundIn(cvText, x.city)),
    summary: keep('summary', x.summary, foundIn(cvText, x.summary)),
    experience: [],
    education: [],
    skills: [],
    languages: [],
  };
  for (const e of x.experience) {
    if (!foundIn(cvText, e.company) && !foundIn(cvText, e.title)) {
      dropped.push({ lang, what: 'experience', value: `${e.title} @ ${e.company}` });
      continue;
    }
    const start = dropUnsupportedMonth(cvText, normDate(e.start));
    const end = dropUnsupportedMonth(cvText, normDate(e.end));
    clean.experience.push({
      ...e,
      company: foundIn(cvText, e.company) ? e.company : '',
      title: foundIn(cvText, e.title) ? e.title : '',
      start: yearOk(cvText, start) ? start : (dropped.push({ lang, what: `start date (${e.company})`, value: String(e.start) }), null),
      end: yearOk(cvText, end) ? end : (dropped.push({ lang, what: `end date (${e.company})`, value: String(e.end) }), null),
      skills: e.skills.filter((s) => foundIn(cvText, s) || (dropped.push({ lang, what: `skill in ${e.company}`, value: s }), false)),
      highlights: e.highlights.filter((h) => foundIn(cvText, h) || (dropped.push({ lang, what: `highlight in ${e.company}`, value: h }), false)),
    });
  }
  for (const ed of x.education) {
    if (!foundIn(cvText, ed.institution)) {
      dropped.push({ lang, what: 'education', value: ed.institution });
      continue;
    }
    clean.education.push({
      ...ed,
      degree: foundIn(cvText, ed.degree) ? ed.degree : null,
      field: foundIn(cvText, ed.field) ? ed.field : null,
      start: yearOk(cvText, normDate(ed.start)) ? dropUnsupportedMonth(cvText, normDate(ed.start)) : null,
      end: yearOk(cvText, normDate(ed.end)) ? dropUnsupportedMonth(cvText, normDate(ed.end)) : null,
    });
  }
  const seenSkill = new Set<string>();
  for (const s of x.skills) {
    if (seenSkill.has(s.name.toLowerCase())) continue;
    seenSkill.add(s.name.toLowerCase());
    if (!foundIn(cvText, s.name)) {
      dropped.push({ lang, what: 'skill', value: s.name });
      continue;
    }
    if (isDescriptivePhrase(s.name)) {
      dropped.push({ lang, what: 'skill (descriptive phrase, not a skill name)', value: s.name });
      continue;
    }
    // stated years must literally appear in the text
    const yearsOk = s.statedYears === null || new RegExp(`\\b${s.statedYears}\\+?\\s*(years?|yrs?|שנים|שנות|שנה)`, 'i').test(cvText);
    if (!yearsOk) dropped.push({ lang, what: `stated years for ${s.name}`, value: String(s.statedYears) });
    clean.skills.push({ name: s.name, statedYears: yearsOk ? s.statedYears : null });
  }
  for (const l of x.languages) {
    if (foundIn(cvText, l.name)) clean.languages.push({ name: l.name, level: foundIn(cvText, l.level) ? l.level : null });
    else dropped.push({ lang, what: 'language', value: l.name });
  }
  return { clean, dropped };
}

/** "risk gates", "modern development methodologies": multi-word, all-lowercase Latin text is prose, not a skill name. */
export const isDescriptivePhrase = (s: string): boolean => /^[a-z][a-z0-9\s-]*$/.test(s.trim()) && s.trim().split(/\s+/).length >= 2;

/** Profile links: http(s) only, deduped ignoring protocol/www/trailing slash. */
export function cleanLinks(urls: string[]): string[] {
  const seen = new Map<string, string>();
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) continue;
    const key = u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    if (!seen.has(key) || u.startsWith('https')) seen.set(key, u);
  }
  return [...seen.values()];
}

// ---------- deterministic contact ----------
export function contactFromText(text: string): { email: string | null; phone: string | null } {
  const email = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] ?? null;
  const phone = text.match(/(?:\+972[-\s]?|0)5\d(?:[-\s]?\d){7}/)?.[0] ?? null;
  return { email, phone };
}
const phoneDigits = (p: string | null) => (p ? p.replace(/\D/g, '').replace(/^972/, '0') : null);

// ---------- merge ----------
export interface Conflict {
  kind: 'contradiction' | 'only_in_one' | 'suggested';
  where: string;
  detail: string;
}

const slug = (s: string) =>
  normalizeText(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)[0] ?? '';

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

/** Two dates agree if equal, or if one is year-only and the other is a month in that year. */
const datesAgree = (a: string | null, b: string | null) => !a || !b || a === b || (a.length === 4 && b.startsWith(a)) || (b.length === 4 && a.startsWith(b));
const pickDate = (a: string | null, b: string | null): string | null => {
  if (!datesAgree(a, b)) return `CONFLICT he=${a} en=${b}`;
  return [a, b].filter(Boolean).sort((x, y) => y!.length - x!.length)[0] ?? null;
};

export function mergeProfiles(
  input: { he: Extracted; en: Extracted; heText: string; enText: string; links: string[] },
  align: Alignment,
): { profile: Profile; conflicts: Conflict[] } {
  const { he, en } = input;
  const conflicts: Conflict[] = [];
  const used = new Set<string>();

  // contact (deterministic)
  const ch = contactFromText(input.heText);
  const ce = contactFromText(input.enText);
  const email = ch.email && ce.email && ch.email.toLowerCase() !== ce.email.toLowerCase() ? `CONFLICT he=${ch.email} en=${ce.email}` : (ce.email ?? ch.email);
  if (email?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: 'contact.email', detail: email });
  const phone = ch.phone && ce.phone && phoneDigits(ch.phone) !== phoneDigits(ce.phone) ? `CONFLICT he=${ch.phone} en=${ce.phone}` : (ch.phone ?? ce.phone);
  if (phone?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: 'contact.phone', detail: phone });

  // skills
  const skills: Profile['skills'] = [];
  const skillByKey = new Map<string, Profile['skills'][number]>();
  const addSkill = (name: string, lang: Lang, statedYears: number | null): string => {
    const k = skillKey(name);
    let s = skillByKey.get(k);
    if (!s) {
      s = { id: uniqueId(`skill.${k.replace(/\s+/g, '-').replace(/#/g, 'sharp').replace(/\+/g, 'p') || 'x'}`, used), name, aliases: [], statedYears, sources: [lang] };
      skillByKey.set(k, s);
      skills.push(s);
      return s.id;
    }
    if (s.name !== name && !s.aliases.includes(name)) s.aliases.push(name);
    if (!s.sources.includes(lang)) s.sources.push(lang);
    if (statedYears !== null) {
      if (s.statedYears === null) s.statedYears = statedYears;
      else if (s.statedYears !== statedYears) {
        conflicts.push({ kind: 'contradiction', where: `${s.id} stated years`, detail: `${s.statedYears} vs ${statedYears} (${lang})` });
        s.statedYears = null;
      }
    }
    return s.id;
  };
  /** Compound strings are split; stated years only stick to a single, unsplit skill. */
  const addSkills = (name: string, lang: Lang, statedYears: number | null): string[] => {
    const parts = splitSkill(name);
    return parts.map((p) => addSkill(p, lang, parts.length === 1 ? statedYears : null));
  };
  for (const s of en.skills) addSkills(s.name, 'en', s.statedYears);
  for (const s of he.skills) addSkills(s.name, 'he', s.statedYears);

  // experience
  const experience: Profile['experience'] = [];
  const seenHe = new Set<number>();
  const seenEn = new Set<number>();
  const pairs = align.experience.filter((p) => {
    const okHe = p.he === null || (p.he >= 0 && p.he < he.experience.length && !seenHe.has(p.he));
    const okEn = p.en === null || (p.en >= 0 && p.en < en.experience.length && !seenEn.has(p.en));
    if (!okHe || !okEn || (p.he === null && p.en === null)) return false;
    if (p.he !== null) seenHe.add(p.he);
    if (p.en !== null) seenEn.add(p.en);
    return true;
  });
  he.experience.forEach((_, i) => !seenHe.has(i) && pairs.push({ he: i, en: null, titleMismatch: false, note: '' }));
  en.experience.forEach((_, i) => !seenEn.has(i) && pairs.push({ he: null, en: i, titleMismatch: false, note: '' }));

  for (const p of pairs) {
    const h = p.he !== null ? he.experience[p.he] : undefined;
    const e = p.en !== null ? en.experience[p.en] : undefined;
    const base = slug(e?.company ?? '') || slug(e?.title ?? '') || 'role';
    const id = uniqueId(`exp.${base}`, used);
    const label = e ? `${e.title} @ ${e.company}` : `${h!.title} @ ${h!.company}`;
    const start = pickDate(h?.start ?? null, e?.start ?? null);
    const end = pickDate(h?.end ?? null, e?.end ?? null);
    if (start?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: `${id} start (${label})`, detail: start });
    if (end?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: `${id} end (${label})`, detail: end });
    if (h && e && h.kind !== e.kind) conflicts.push({ kind: 'contradiction', where: `${id} kind`, detail: `he=${h.kind} en=${e.kind}` });
    if (p.titleMismatch) conflicts.push({ kind: 'suggested', where: `${id} title`, detail: `he="${h?.title}" en="${e?.title}" — ${p.note} (flagged by the model; verify)` });
    if (!h || !e) conflicts.push({ kind: 'only_in_one', where: id, detail: `${label} appears only in the ${h ? 'Hebrew' : 'English'} CV` });
    const skillIds = new Set<string>();
    for (const s of e?.skills ?? []) for (const id of addSkills(s, 'en', null)) skillIds.add(id);
    for (const s of h?.skills ?? []) for (const id of addSkills(s, 'he', null)) skillIds.add(id);
    experience.push({
      id,
      kind: (e ?? h)!.kind,
      company: { he: h?.company || null, en: e?.company || null },
      title: { he: h?.title || null, en: e?.title || null },
      start,
      end,
      skills: [...skillIds],
      highlights: { he: h?.highlights ?? [], en: e?.highlights ?? [] },
      sources: [...(h ? ['he' as const] : []), ...(e ? ['en' as const] : [])],
    } as Profile['experience'][number]);
  }

  // education
  const education: Profile['education'] = [];
  const eHe = new Set<number>();
  const eEn = new Set<number>();
  const epairs = align.education.filter((p) => {
    const ok = (p.he === null || (p.he < he.education.length && !eHe.has(p.he))) && (p.en === null || (p.en < en.education.length && !eEn.has(p.en)));
    if (!ok || (p.he === null && p.en === null)) return false;
    if (p.he !== null) eHe.add(p.he);
    if (p.en !== null) eEn.add(p.en);
    return true;
  });
  he.education.forEach((_, i) => !eHe.has(i) && epairs.push({ he: i, en: null }));
  en.education.forEach((_, i) => !eEn.has(i) && epairs.push({ he: null, en: i }));
  for (const p of epairs) {
    const h = p.he !== null ? he.education[p.he] : undefined;
    const e = p.en !== null ? en.education[p.en] : undefined;
    const id = uniqueId(`edu.${slug(e?.institution ?? '') || 'school'}`, used);
    const start = pickDate(h?.start ?? null, e?.start ?? null);
    const end = pickDate(h?.end ?? null, e?.end ?? null);
    if (start?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: `${id} start`, detail: start });
    if (end?.startsWith('CONFLICT')) conflicts.push({ kind: 'contradiction', where: `${id} end`, detail: end });
    if (!h || !e) conflicts.push({ kind: 'only_in_one', where: id, detail: `${(e ?? h)!.institution} appears only in the ${h ? 'Hebrew' : 'English'} CV` });
    education.push({
      id,
      institution: { he: h?.institution ?? null, en: e?.institution ?? null },
      degree: { he: h?.degree ?? null, en: e?.degree ?? null },
      field: { he: h?.field ?? null, en: e?.field ?? null },
      start,
      end,
      sources: [...(h ? ['he' as const] : []), ...(e ? ['en' as const] : [])],
    } as Profile['education'][number]);
  }

  // skills only in one CV
  // skills only in one CV: one compact note per language (often just wording/translation differences)
  for (const lang of ['he', 'en'] as const) {
    const only = skills.filter((s) => s.sources.length === 1 && s.sources[0] === lang).map((s) => s.name);
    if (only.length) conflicts.push({ kind: 'only_in_one', where: `skills only in the ${lang === 'he' ? 'Hebrew' : 'English'} CV`, detail: only.join(', ') });
  }

  // languages: pair by position when both CVs list the same number
  const languages: Profile['languages'] =
    he.languages.length === en.languages.length
      ? en.languages.map((l, i) => ({ id: uniqueId(`lang.${slug(l.name) || i}`, used), name: { he: he.languages[i]!.name, en: l.name }, level: { he: he.languages[i]!.level, en: l.level } }))
      : [
          ...en.languages.map((l) => ({ id: uniqueId(`lang.${slug(l.name) || 'x'}`, used), name: { he: null, en: l.name }, level: { he: null, en: l.level } })),
          ...he.languages.map((l, i) => ({ id: uniqueId(`lang.he${i + 1}`, used), name: { he: l.name, en: null }, level: { he: l.level, en: null } })),
        ];
  if (he.languages.length !== en.languages.length) conflicts.push({ kind: 'only_in_one', where: 'languages', detail: `Hebrew CV lists ${he.languages.length}, English CV lists ${en.languages.length}` });

  const links = cleanLinks(input.links).map((url) => {
    const host = url.replace(/^https?:\/\/(www\.)?/, '').split(/[/.]/)[0] ?? 'link';
    return { id: uniqueId(`link.${host.toLowerCase()}`, used), label: host, url };
  });

  const profile = {
    meta: {},
    contact: { name: { he: he.name, en: en.name }, email, phone, city: { he: he.city, en: en.city } },
    links,
    summary: { he: he.summary, en: en.summary },
    experience,
    education,
    skills,
    languages,
  } as Profile;
  return { profile, conflicts };
}

export function conflictsMarkdown(conflicts: Conflict[], dropped: Dropped[], missed: Array<{ lang: Lang; line: string }> = []): string {
  const sec = (title: string, items: string[]) => [`## ${title}`, '', ...(items.length ? items : ['(none)']), ''];
  const c = (k: Conflict['kind']) => conflicts.filter((x) => x.kind === k).map((x) => `- [ ] **${x.where}**: ${x.detail}`);
  return [
    '# profile.draft.json — conflicts to resolve',
    '',
    'Fix these in profile.draft.json, then rename it to profile.json. Values written as `CONFLICT he=… en=…` must be replaced;',
    'profile.json will not load while any remain.',
    '',
    ...sec('Contradictions between the two CVs', c('contradiction')),
    ...sec('Possible title mismatches (flagged by the model, may be translation only)', c('suggested')),
    ...sec('Present in only one CV', c('only_in_one')),
    ...sec('Possibly missed — dated CV lines that no extracted entry covers (add by hand if relevant)', missed.map((m) => `- (${m.lang}) ${m.line}`)),
    ...sec('Dropped — extracted by the model but not found in the CV text', dropped.map((d) => `- (${d.lang}) ${d.what}: ${d.value}`)),
  ].join('\n');
}
