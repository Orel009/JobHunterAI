import type { Job } from '../sites/types.js';
import { isAnonymousCompany, normalizeText } from './text.js';

export interface DedupeCandidate {
  id: string;
  site: string;
  companyNorm: string;
  titleNorm: string;
  firstSeenAt: string; // ISO
}

// ---------- the same company ----------
/** legal forms, the country and "technologies" at the end of a name: "Voice Spin Ltd" = "VoiceSpin" = "voicespin israel" */
const COMPANY_TAIL = new Set(['ltd', 'limited', 'inc', 'llc', 'corp', 'co', 'בעמ', 'בע', 'מ', 'israel', 'il', 'ישראל', 'technologies', 'טכנולוגיות', 'group', 'קבוצת']);

/**
 * The company as one key: normalized (case, punctuation, niqqud), the legal form / "Israel" / "technologies" at the end
 * dropped, and no spaces — "Voice Spin", "voicespin", "Voice-Spin Ltd." are one key. Accepts a raw name or companyNorm.
 */
export function companyKey(company: string): string {
  const t = normalizeText(company).split(' ').filter(Boolean);
  while (t.length > 1 && COMPANY_TAIL.has(t[t.length - 1]!)) t.pop();
  return t.join('');
}

const HEB = /[א-ת]/;
const LAT = /[a-z]/;

/** Hebrew letters → sound classes (vowel letters dropped; וו and a leading ו are v/w). */
function hebrewSkeleton(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === 'ו') {
      if (s[i + 1] === 'ו') {
        out += 'P';
        i++;
      } else if (i === 0) out += 'P';
      continue;
    }
    out += ({ ב: 'P', פ: 'P', ף: 'P', כ: 'K', ך: 'K', ק: 'K', ח: 'K', ג: 'G', ד: 'D', ט: 'T', ת: 'T', ס: 'S', ש: 'S', ז: 'S', צ: 'TS', ץ: 'TS', ל: 'L', מ: 'M', ם: 'M', נ: 'N', ן: 'N', ר: 'R' } as Record<string, string>)[c] ?? (/\d/.test(c) ? c : '');
  }
  return out;
}

/** Latin letters → the same sound classes; "ch" is ambiguous (Chen = חן, Check = צ'ק), so it gives both readings. */
function latinSkeletons(s: string): string[] {
  const one = (ch: string) => {
    const x = s.replace(/ph/g, 'f').replace(/th/g, 't').replace(/sh/g, 's').replace(/ck/g, 'k').replace(/ch/g, ch).replace(/t[sz]/g, '§').replace(/c(?=[eiy])/g, 's');
    let out = '';
    for (const c of x) {
      out += ({ '§': 'TS', '¤': 'K', b: 'P', v: 'P', f: 'P', p: 'P', w: 'P', k: 'K', c: 'K', q: 'K', g: 'G', j: 'G', d: 'D', t: 'T', s: 'S', z: 'S', x: 'KS', l: 'L', m: 'M', n: 'N', r: 'R' } as Record<string, string>)[c] ?? (/\d/.test(c) ? c : '');
    }
    return out;
  };
  return [...new Set([one('¤'), one('§')])];
}

const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');

/** The name's consonant skeleton(s), for a Hebrew spelling vs an English one ("וויס ספין" = "Voice Spin" → PSPN). */
export function companySkeletons(company: string): { script: 'he' | 'en' | 'mixed' | 'none'; skeletons: string[] } {
  const k = companyKey(company);
  const he = HEB.test(k);
  const en = LAT.test(k);
  if (he && en) return { script: 'mixed', skeletons: [] };
  if (he) return { script: 'he', skeletons: [collapse(hebrewSkeleton(k))] };
  if (en) return { script: 'en', skeletons: latinSkeletons(k).map(collapse) };
  return { script: 'none', skeletons: [] };
}

/** a skeleton this short says too little to call two names the same */
const MIN_SKELETON = 3;
const keyCache = new Map<string, { key: string; script: string; skeletons: string[] }>();
function companyParts(company: string) {
  let p = keyCache.get(company);
  if (!p) {
    if (keyCache.size > 20_000) keyCache.clear();
    p = { key: companyKey(company), ...companySkeletons(company) };
    keyCache.set(company, p);
  }
  return p;
}

/**
 * The same company: the same key (case, spaces, punctuation, legal form), or one name in Hebrew and the other in
 * English with the same consonant skeleton (at least 3 sounds). Anonymous / empty companies are never the same.
 */
export function sameCompany(a: string, b: string): boolean {
  if (!a || !b || isAnonymousCompany(normalizeText(a)) || isAnonymousCompany(normalizeText(b))) return false;
  const x = companyParts(a);
  const y = companyParts(b);
  if (!x.key || !y.key) return false;
  if (x.key === y.key) return true;
  if (!((x.script === 'he' && y.script === 'en') || (x.script === 'en' && y.script === 'he'))) return false;
  return x.skeletons.some((s) => s.length >= MIN_SKELETON && y.skeletons.includes(s));
}

// ---------- the same title ----------
const SENIORITY = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'head', 'manager', 'intern', 'student', 'בכיר', 'בכירה', 'זוטר', 'זוטרה', 'גוניור', 'ראש', 'מנהל', 'מנהלת', 'סטודנט', 'סטודנטית', 'מתמחה']);
/** a job code / id token: digits (4+), or letters glued to 3+ digits ("req12345") */
const isIdToken = (t: string) => /^\d{4,}$/.test(t) || /^[a-z]{1,4}\d{3,}$/.test(t);
const isCodePrefix = (t: string) => /^[a-z]{1,4}$/.test(t);

/**
 * The title without its job code or id: "Forward Deployed Engineer (AI) - JB-96" → "forward deployed engineer ai",
 * "מפתח/ת Full Stack … - 1124314" → "מפתח full stack …". Direction marks (‏) and punctuation are already gone in the
 * normalized title. Accepts a raw title or titleNorm.
 */
export function titleKey(title: string): string {
  return splitTitle(title).key;
}

/** The title's job code / id on its own ("jb 96", "1124314"), empty when it has none. */
export const titleCode = (title: string): string => splitTitle(title).code;

function splitTitle(title: string): { key: string; code: string } {
  const all = normalizeText(title).split(' ').filter(Boolean);
  const code: string[] = all.filter(isIdToken);
  const t = all.filter((x) => !isIdToken(x));
  // a code at the end or the start: "jb 96", "req 1234", "#1234" (letters 1–4 + digits 2+)
  const isNum = (x: string | undefined) => !!x && /^\d{2,}$/.test(x);
  while (t.length > 1 && isNum(t[t.length - 1])) {
    code.push(t.pop()!);
    if (t.length > 1 && isCodePrefix(t[t.length - 1]!)) code.push(t.pop()!);
  }
  while (t.length > 1 && isNum(t[0])) code.push(t.shift()!);
  if (t.length > 2 && isCodePrefix(t[0]!) && isNum(t[1])) code.push(...t.splice(0, 2));
  return { key: t.join(' '), code: code.sort().join(' ') };
}

const titleCache = new Map<string, { key: string; code: string }>();
const cachedTitle = (s: string) => {
  let k = titleCache.get(s);
  if (k === undefined) {
    if (titleCache.size > 20_000) titleCache.clear();
    k = splitTitle(s);
    titleCache.set(s, k);
  }
  return k;
};

/**
 * The same title: the same key (job codes / ids dropped), the same words without spaces ("fullstack" = "full stack")
 * or in another order, or — with 4+ words in common — one extra word on one side (e.g. "היברידי"), unless that word is
 * a seniority word (Senior / Junior / Lead / בכיר …: another position). A code on one side only is ignored (one site
 * shows it, the other does not); two DIFFERENT codes are two requisitions ("Angular Developer - 533313" / "- 533761").
 */
export function sameTitle(a: string, b: string): boolean {
  const ta = cachedTitle(a);
  const tb = cachedTitle(b);
  const x = ta.key;
  const y = tb.key;
  if (!x || !y) return false;
  if (ta.code && tb.code && ta.code !== tb.code) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const sx = new Set(x.split(' '));
  const sy = new Set(y.split(' '));
  const common = [...sx].filter((t) => sy.has(t)).length;
  const extra = [...sx].filter((t) => !sy.has(t)).concat([...sy].filter((t) => !sx.has(t)));
  if (extra.length === 0) return true; // the same words in another order
  return common >= 4 && extra.length === 1 && !SENIORITY.has(extra[0]!) && !/^\d+$/.test(extra[0]!);
}

// ---------- the same job ----------
/**
 * The same job, wherever it was found: the same company (sameCompany) and the same title (sameTitle), first seen
 * within `windowDays` of each other — on another site, or on the same site under another job id (a repost). The same
 * job id is the same job (an update, not a duplicate). Anonymous companies ("חסוי") never match: nothing to compare.
 */
export function isDuplicateJob(job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'> & { id?: string }, seenAt: Date, other: DedupeCandidate, windowDays: number): boolean {
  if (job.id !== undefined && other.id === job.id) return false;
  if (!sameCompany(job.companyNorm, other.companyNorm) || !sameTitle(job.titleNorm, other.titleNorm)) return false;
  const diffDays = Math.abs(seenAt.getTime() - new Date(other.firstSeenAt).getTime()) / 86_400_000;
  return diffDays <= windowDays;
}

/** The original of a job just found: the earliest matching job, or null. */
export function findDuplicate(job: Pick<Job, 'site' | 'companyNorm' | 'titleNorm'> & { id?: string }, seenAt: Date, candidates: DedupeCandidate[], windowDays: number): DedupeCandidate | null {
  const matches = candidates.filter((c) => isDuplicateJob(job, seenAt, c, windowDays)).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  return matches[0] ?? null;
}

/**
 * Groups of the same job among many rows (same company + same title, transitively): the company keys are grouped
 * first (cheap), then the titles within each company group.
 */
export function groupSameJobs<T extends { companyNorm: string; titleNorm: string }>(rows: T[]): T[][] {
  const named = rows.filter((r) => r.companyNorm && r.titleNorm && !isAnonymousCompany(r.companyNorm));
  // 1. company groups over the distinct keys
  const byKey = new Map<string, T[]>();
  for (const r of named) {
    const k = companyParts(r.companyNorm).key;
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const keys = [...byKey.keys()];
  const parent = keys.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (find(i) !== find(j) && sameCompany(byKey.get(keys[i]!)![0]!.companyNorm, byKey.get(keys[j]!)![0]!.companyNorm)) parent[find(i)] = find(j);
    }
  }
  const companies = new Map<number, T[]>();
  keys.forEach((k, i) => companies.set(find(i), [...(companies.get(find(i)) ?? []), ...byKey.get(k)!]));
  // 2. within a company group, the same title (transitively)
  const out: T[][] = [];
  for (const g of companies.values()) {
    const p = g.map((_, i) => i);
    const f = (i: number): number => (p[i] === i ? i : (p[i] = f(p[i]!)));
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (f(i) !== f(j) && sameTitle(g[i]!.titleNorm, g[j]!.titleNorm)) p[f(i)] = f(j);
    const groups = new Map<number, T[]>();
    g.forEach((r, i) => groups.set(f(i), [...(groups.get(f(i)) ?? []), r]));
    for (const x of groups.values()) if (x.length > 1) out.push(x);
  }
  return out;
}

/** @deprecated names from when only other sites counted */
export const isCrossSiteDuplicate = isDuplicateJob;
export const findCrossSiteDuplicate = findDuplicate;
