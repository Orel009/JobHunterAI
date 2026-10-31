/**
 * Posted salary — deterministic, never from the LLM.
 *   1. Drushim's own salary field (job page `salaryRange`, also written into the description as "שכר: 10000-13000")
 *   2. a salary mention in the title / description / requirements ("שכר", "משכורת", "salary"; ₪, ש״ח, k, ranges)
 *   3. Drushim's search-card salary bucket (salaryRangeId), marked approximate
 * Monthly gross ILS is the unit used for floors, answers and market stats; hourly pay is kept separately.
 * Then: per-role-type settings (role type → its tier → default), the floor check, and the answer to a salary question.
 */
import type { Prefs, RoleType } from './prefs.js';

export type SalaryUnit = 'month' | 'hour';
export type SalarySource = 'drushim_field' | 'description' | 'drushim_bucket';

export interface PostedSalary {
  min: number | null;
  max: number | null;
  unit: SalaryUnit;
  source: SalarySource;
  /** the text it was read from (provenance) */
  text: string;
}

const MONTH = { lo: 3_000, hi: 100_000 };
const HOUR = { lo: 25, hi: 500 };

const HOURLY = /לשעה|שעתי|per hour|\/\s*hour|an hour|hourly/i;
/** words that mean the number right after is not a salary */
const NOT_SALARY_BEFORE = /מענק|בונוס|bonus|הטבות|בשווי|תן ביס|סיבוס|cibus|grant|ביטוח|קרן השתלמות|ארוחות/i;
const NOT_SALARY_AFTER = /^\s*(?:₪|ש["״']?ח|nis|ils)?\s*(?:לכל יום|ליום|per day|לחודש בשווי|ימים|יום|שעות|שנים|שנות|שנה|days?|hours?|years?|%|אחוז)/i;

/** "11,000" → 11000, times and dates out of the way */
const clean = (s: string) =>
  s
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, ' ');

// a "k" / "אלף" suffix counts only when it is not the start of a word ("15 קבועים", "8 keys")
const NUM = String.raw`(\d+(?:\.\d+)?)(?:\s*(k|K|אלף)(?![a-zA-Zא-ת]))?(?!\d)`;
const RANGE = new RegExp(String.raw`${NUM}\s*(?:-|–|—|עד|ל-|ל\s|to)\s*${NUM}`);
const SINGLE = new RegExp(NUM);

function scale(n: number, k: boolean, unit: SalaryUnit, inRange: boolean): number {
  if (k) return n * 1000;
  // "השכר ינוע בין 8-10": small monthly numbers in a RANGE are thousands (a lone one needs a k)
  if (inRange && unit === 'month' && n >= 4 && n < 100) return n * 1000;
  return n;
}

const plausible = (n: number, unit: SalaryUnit) => (unit === 'month' ? n >= MONTH.lo && n <= MONTH.hi : n >= HOUR.lo && n <= HOUR.hi);

/**
 * One snippet → a range (or null). `snippet` is the text right after a salary keyword (or a salary field value).
 * "מעל / החל מ / from / +" → minimum only; "עד / up to" before a single number → maximum only.
 */
export function parseSalarySnippet(raw: string): Omit<PostedSalary, 'source' | 'text'> | null {
  const s = clean(raw);
  const unit: SalaryUnit = HOURLY.test(s) ? 'hour' : 'month';
  const r = RANGE.exec(s);
  if (r && !NOT_SALARY_BEFORE.test(s.slice(0, r.index)) && !NOT_SALARY_AFTER.test(s.slice(r.index + r[0].length))) {
    const anyK = !!(r[2] || r[4]);
    const a = scale(Number(r[1]), anyK, unit, true);
    const b = scale(Number(r[3]), anyK, unit, true);
    const [min, max] = a <= b ? [a, b] : [b, a];
    if (plausible(min, unit) && plausible(max, unit)) return { min, max, unit };
  }
  const m = SINGLE.exec(s);
  if (!m || NOT_SALARY_BEFORE.test(s.slice(0, m.index)) || NOT_SALARY_AFTER.test(s.slice(m.index + m[0].length))) return null;
  const v = scale(Number(m[1]), !!m[2], unit, false);
  if (!plausible(v, unit)) return null;
  const before = s.slice(Math.max(0, m.index - 12), m.index);
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 4);
  if (/מעל|החל מ|from|starting|לפחות|at least/i.test(before) || /^\s*\+/.test(after)) return { min: v, max: null, unit };
  if (/עד|up to/i.test(before)) return { min: null, max: v, unit };
  return { min: v, max: v, unit };
}

const KEYWORD = /שכר|משכורת|salary|compensation|תגמול/gi;
const WINDOW = 45;

/** First salary mention in free text: the snippet after each salary keyword, up to the end of that sentence. */
export function salaryFromText(text: string): PostedSalary | null {
  let hourly: PostedSalary | null = null;
  for (const k of text.matchAll(KEYWORD)) {
    const start = k.index! + k[0].length;
    const snippet = text.slice(start, start + WINDOW).split(/[•!|\n;]|\.\s/)[0]!;
    const p = parseSalarySnippet(snippet);
    if (!p) continue;
    const found: PostedSalary = { ...p, source: 'description', text: `${k[0]}${snippet}`.replace(/\s+/g, ' ').trim() };
    if (p.unit === 'month') return found;
    hourly ??= found;
  }
  return hourly;
}

/** Drushim search-card salary buckets (salaryRangeId = lower bound + 1), as on the site's salary filter. */
const BUCKETS: Record<number, [number, number | null]> = {
  7001: [7000, 10000],
  10001: [10000, 13000],
  13001: [13000, 15000],
  15001: [15000, 18000],
  18001: [18000, 25000],
  25001: [25000, 30000],
};

export function salaryFromBucket(id: unknown): PostedSalary | null {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1000) return null;
  const [min, max] = BUCKETS[n] ?? [n - 1, null];
  return { min, max, unit: 'month', source: 'drushim_bucket', text: `salaryRangeId ${n} (approximate bucket)` };
}

/** The job's posted salary, best source first. */
export function jobSalary(job: { title: string; descriptionText: string; requirementsText: string; raw?: unknown }): PostedSalary | null {
  const raw = (job.raw ?? {}) as { salaryRange?: unknown; salaryRangeId?: unknown };
  if (typeof raw.salaryRange === 'string' && raw.salaryRange.trim()) {
    const p = parseSalarySnippet(raw.salaryRange);
    if (p) return { ...p, source: 'drushim_field', text: `salaryRange "${raw.salaryRange}"` };
  }
  // Drushim's field, as written into the description by the job-page mapper ("היקף: … | ניסיון: … | שכר: 10000-13000")
  const field = /(?:^|\|\s*|\n)שכר: ([^|\n]+)/.exec(job.descriptionText);
  if (field) {
    const p = parseSalarySnippet(field[1]!);
    if (p) return { ...p, source: 'drushim_field', text: `שכר: ${field[1]!.trim()}` };
  }
  return salaryFromText(`${job.title}\n${job.descriptionText}\n${job.requirementsText}`) ?? salaryFromBucket(raw.salaryRangeId);
}

// ---------- settings ----------
export interface SalarySettings {
  /** minimum acceptable monthly gross; null = no salary filtering */
  floor: number | null;
  /** answer to a text salary question when the job posts no range */
  textAnswerNoRange: string;
  /** answer to a number-only salary field when the job posts no range */
  numericFallback: number | null;
  /** where each value came from: role:<id> | tier<n> | default | unset */
  from: { floor: string; textAnswerNoRange: string; numericFallback: string };
}

/** The suggested wording for textAnswerNoRange (offered in the editor; never filled in by itself). */
export const SUGGESTED_TEXT_NO_RANGE = 'גמיש, בהתאם להיקף התפקיד ולתנאים';

type Partial3 = { floor?: number | null; textAnswerNoRange?: string | null; numericFallback?: number | null } | undefined;
const set = (v: unknown) => v !== null && v !== undefined && v !== '';

/** Per field: the role type's own value, else its tier's, else the default. Empty values fall through. */
export function salarySettings(prefs: Pick<Prefs, 'salary'>, role: Pick<RoleType, 'id' | 'tier' | 'salary'> | null): SalarySettings {
  const layers: Array<[string, Partial3]> = [
    ...(role ? ([[`role:${role.id}`, role.salary]] as Array<[string, Partial3]>) : []),
    ...(role ? ([[`tier${role.tier}`, prefs.salary[`tier${role.tier}` as 'tier1' | 'tier2' | 'tier3']]] as Array<[string, Partial3]>) : []),
    ['default', prefs.salary.default],
  ];
  const pick = <K extends 'floor' | 'textAnswerNoRange' | 'numericFallback'>(k: K) => {
    for (const [name, l] of layers) if (l && set(l[k])) return { v: l[k], from: name };
    return { v: null, from: 'unset' };
  };
  const floor = pick('floor');
  const text = pick('textAnswerNoRange');
  const num = pick('numericFallback');
  return {
    floor: (floor.v as number | null) ?? null,
    textAnswerNoRange: ((text.v as string | null) ?? '').trim(),
    numericFallback: (num.v as number | null) ?? null,
    from: { floor: floor.from, textAnswerNoRange: text.from, numericFallback: num.from },
  };
}

export const fmtIls = (n: number) => n.toLocaleString('en-US');
export const describeSalary = (s: Pick<PostedSalary, 'min' | 'max' | 'unit'>) => {
  const r = s.min !== null && s.max !== null && s.min !== s.max ? `${fmtIls(s.min)}–${fmtIls(s.max)}` : s.min !== null && s.max === null ? `${fmtIls(s.min)}+` : s.max !== null && s.min === null ? `up to ${fmtIls(s.max)}` : fmtIls(s.min ?? s.max ?? 0);
  return `${r} ₪${s.unit === 'hour' ? '/hour' : ''}`;
};

/** Posted monthly maximum below the floor → the job is skipped (status skipped_salary). */
export function belowFloor(s: Pick<PostedSalary, 'min' | 'max' | 'unit'> | null, floor: number | null): boolean {
  return !!s && floor !== null && s.unit === 'month' && s.max !== null && s.max < floor;
}

export interface SalaryAnswer {
  status: 'resolved' | 'pending';
  value: string | null;
  /** posted range | fallback | pending */
  basis: 'posted range' | 'fallback' | 'pending';
  detail: string;
}

const round500 = (n: number) => Math.round(n / 500) * 500;

/**
 * The answer to a salary question for this job:
 *   posted monthly range reaching the floor → text "X–Y ₪ ברוטו" (X = max(min, floor)), number = X rounded to 500
 *   no posted range → textAnswerNoRange / numericFallback; neither set → pending
 */
export function composeSalaryAnswer(posted: PostedSalary | null, st: SalarySettings, kind: 'text' | 'number'): SalaryAnswer {
  const monthly = posted && posted.unit === 'month' && (posted.min !== null || posted.max !== null) ? posted : null;
  if (monthly) {
    if (belowFloor(monthly, st.floor)) return { status: 'pending', value: null, basis: 'pending', detail: `posted ${describeSalary(monthly)} is below your floor ${fmtIls(st.floor!)} ₪` };
    const lo = monthly.min ?? monthly.max!;
    const x = st.floor !== null ? Math.max(lo, st.floor) : lo;
    const y = monthly.max;
    const text = y !== null && y > x ? `${fmtIls(x)}–${fmtIls(y)} ₪ ברוטו` : `${fmtIls(x)} ₪ ברוטו`;
    const detail = `posted ${describeSalary(monthly)} (${monthly.source === 'drushim_bucket' ? 'approximate bucket' : monthly.source === 'drushim_field' ? 'site salary field' : 'from the post text'})${st.floor !== null ? `, floor ${fmtIls(st.floor)} ₪` : ''}`;
    return kind === 'number' ? { status: 'resolved', value: String(round500(x)), basis: 'posted range', detail } : { status: 'resolved', value: text, basis: 'posted range', detail };
  }
  const why = posted?.unit === 'hour' ? `only an hourly rate is posted (${describeSalary(posted)})` : 'no salary posted';
  if (kind === 'number') {
    return st.numericFallback !== null
      ? { status: 'resolved', value: String(st.numericFallback), basis: 'fallback', detail: `${why}; numericFallback (${st.from.numericFallback})` }
      : { status: 'pending', value: null, basis: 'pending', detail: `${why}, and no numericFallback is set (Preferences → Salary)` };
  }
  return st.textAnswerNoRange
    ? { status: 'resolved', value: st.textAnswerNoRange, basis: 'fallback', detail: `${why}; textAnswerNoRange (${st.from.textAnswerNoRange})` }
    : { status: 'pending', value: null, basis: 'pending', detail: `${why}, and no textAnswerNoRange is set (Preferences → Salary)` };
}
