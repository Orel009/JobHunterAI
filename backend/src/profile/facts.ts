import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { normalizeText } from '../core/text.js';
import { ProfileSchema, type Profile } from './schema.js';

export const profilePath = () => path.join(config.paths.profileDir, 'profile.json');

/** Loads data/profile/profile.json (validated). null if it doesn't exist yet. Throws on invalid content. */
export function loadProfile(file = profilePath()): Profile | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const unresolved = raw.match(/"CONFLICT [^"]*"/g);
  if (unresolved) throw new Error(`profile.json has unresolved conflicts (see profile.conflicts.md): ${unresolved.join(', ')}`);
  const parsed = ProfileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`profile.json is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return parsed.data;
}

// ---------- dates / years ----------
/**
 * Month index (year*12 + month-1). Conservative for year-only dates so derived years never overstate:
 * a year-only start counts as December of that year, a year-only end as January.
 */
export function monthIndex(d: string, edge: 'start' | 'end', now = new Date()): number {
  if (d === 'present') return now.getFullYear() * 12 + now.getMonth();
  const [y, m] = d.split('-').map(Number) as [number, number | undefined];
  return y * 12 + (m ? m - 1 : edge === 'start' ? 11 : 0);
}

/** Total months covered by a set of [start,end] month intervals (overlaps counted once, inclusive). */
export function unionMonths(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1] + 1) {
      if (cur) total += cur[1] - cur[0] + 1;
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0] + 1;
  return total;
}

export interface SkillYears {
  years: number | null;
  source: 'stated' | 'derived' | null;
  /** experience ids the derivation used */
  from: string[];
}

/**
 * Years for a skill: stated in the CV wins; otherwise derived from the dates of experiences that list the skill.
 * Experiences without both dates are ignored. null when nothing supports a number.
 */
export function skillYears(profile: Profile, skillId: string, now = new Date()): SkillYears {
  const skill = profile.skills.find((s) => s.id === skillId);
  if (!skill) return { years: null, source: null, from: [] };
  if (skill.statedYears !== null) return { years: skill.statedYears, source: 'stated', from: [] };
  const exps = profile.experience.filter((e) => e.skills.includes(skillId) && e.start && e.end);
  if (exps.length === 0) return { years: null, source: null, from: [] };
  const months = unionMonths(exps.map((e) => [monthIndex(e.start!, 'start', now), monthIndex(e.end!, 'end', now)]));
  return { years: Math.round((months / 12) * 10) / 10, source: 'derived', from: exps.map((e) => e.id) };
}

// ---------- skill lookup ----------
/** Canonical key for a skill name: "React.js", "React 19", "react" → "react"; ".NET Core" → "net core". */
export function skillKey(name: string): string {
  return normalizeText(name.replace(/\.js\b/gi, '').replace(/\s+\d+(\.\d+)*\+?$/, ''))
    .replace(/\s+\d+(\s+\d+)*$/, '')
    .split(' ')
    .map((w) => w.replace(/^([a-z]{3,})\d+$/, '$1')) // css3 → css, html5 → html; s3 stays
    .join(' ')
    .trim();
}

/** Deterministic: maps a skill mention (from a question) to a profile skill by name/alias key. */
export function findSkill(profile: Profile, mention: string): Profile['skills'][number] | null {
  const k = skillKey(mention);
  if (!k) return null;
  return profile.skills.find((s) => skillKey(s.name) === k || s.aliases.some((a) => skillKey(a) === k)) ?? null;
}

// ---------- facts ----------
export interface Fact {
  id: string;
  text: string;
}

const bi = (b: { he: string | null; en: string | null }, sep = ' / ') => [b.en, b.he].filter(Boolean).join(sep);

/** Flattens the profile into addressable facts (ids are what drafts must cite). */
export function listFacts(p: Profile, now = new Date()): Fact[] {
  const f: Fact[] = [];
  if (bi(p.contact.name)) f.push({ id: 'contact.name', text: `Name: ${bi(p.contact.name)}` });
  if (p.contact.email) f.push({ id: 'contact.email', text: `Email: ${p.contact.email}` });
  if (p.contact.phone) f.push({ id: 'contact.phone', text: `Phone: ${p.contact.phone}` });
  if (bi(p.contact.city)) f.push({ id: 'contact.city', text: `City: ${bi(p.contact.city)}` });
  for (const l of p.links) f.push({ id: l.id, text: `${l.label}: ${l.url}` });
  if (p.summary.he) f.push({ id: 'summary.he', text: p.summary.he });
  if (p.summary.en) f.push({ id: 'summary.en', text: p.summary.en });
  for (const e of p.experience) {
    const skills = e.skills.map((id) => p.skills.find((s) => s.id === id)?.name ?? id).join(', ');
    f.push({ id: e.id, text: `${e.kind}: ${bi(e.title)} at ${bi(e.company)} (${e.start ?? '?'} – ${e.end ?? '?'})${skills ? `; skills: ${skills}` : ''}` });
    e.highlights.he.forEach((h, i) => f.push({ id: `${e.id}.he.${i + 1}`, text: h }));
    e.highlights.en.forEach((h, i) => f.push({ id: `${e.id}.en.${i + 1}`, text: h }));
  }
  for (const ed of p.education) {
    f.push({ id: ed.id, text: `Education: ${bi(ed.degree)} ${bi(ed.field)} — ${bi(ed.institution)} (${ed.start ?? '?'} – ${ed.end ?? '?'})` });
  }
  for (const s of p.skills) {
    const y = skillYears(p, s.id, now);
    f.push({ id: s.id, text: `Skill: ${s.name}${y.years !== null ? ` (${y.years} years, ${y.source})` : ''}` });
  }
  for (const l of p.languages) f.push({ id: l.id, text: `Language: ${bi(l.name)} — ${bi(l.level)}` });
  return f;
}

/** Compact text for the scorer. */
export function profileForScoring(p: Profile): string {
  return listFacts(p)
    .filter((x) => !x.id.startsWith('contact.') && !x.id.startsWith('link.'))
    .map((x) => `- ${x.text}`)
    .join('\n');
}
