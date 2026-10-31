/**
 * Required-experience extraction from job text — deterministic, Hebrew + English.
 *   - works per clause (lines, bullets, ";"); clauses marked as an advantage are ignored
 *   - a range counts as its minimum; several requirements → the highest minimum
 *     ("2 years overall + 4 years React" → 4)
 *   - only clauses that talk about experience/requirements count (not "the company has 30 years")
 * Also detects junior / entry-level signals.
 */

export interface YearsMatch {
  min: number;
  text: string;
}

export interface ExperienceExtraction {
  requiredYears: number | null;
  matches: YearsMatch[];
  /** the clause that set requiredYears (provenance) */
  text: string | null;
  juniorText: string | null;
}

const NUM: Record<string, number> = {
  // Hebrew (masc/fem forms); "שנה"/"שנתיים" handled separately
  אחת: 1, אחד: 1, שתיים: 2, שתי: 2, שני: 2, שניים: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5,
  שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10,
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const WORDS = Object.keys(NUM).join('|');
const N = `(\\d+(?:\\.\\d+)?|${WORDS})`;
const UNIT = `(?:שנות|שנים|שנה|years?|yrs?)`;
const num = (s: string): number => (/^\d/.test(s) ? Number(s) : (NUM[s.toLowerCase()] ?? NaN));

const ADVANTAGE = /יתרון|advantage|nice to have|a plus|\bplus\b|preferred|רצוי|bonus/i;
const EXPERIENCE_CONTEXT = /ניסיון|נסיון|experience|\bexp\b|לפחות|at least|minimum|מינימום|מעל|over|\+|שנות ותק|ותק/i;
/** clauses about the company, age, or anything that isn't the candidate's experience */
const NOT_CANDIDATE = /החברה|הארגון|company|founded|נוסדה|קיימת|we have|our team has|גיל|age\b|warranty|אחריות ל/i;
const JUNIOR = /\bjunior\b|\bjr\b|entry[ -]level|ללא ניסיון|בלי ניסיון|אין צורך בניסיון|no experience|ג'?וניור|ג׳וניור|בוגרי קורס|בוגרות קורס|בוגר\/ת קורס|בוגרי\/ות קורס|סטודנטים|סטודנט\/ית|students?\b|graduates?\b|0-1 (?:שנים|years)/i;

export function splitClauses(text: string): string[] {
  return text
    .split(/\n|;|•|●|▪|•|\s\|\s/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Years expressions in one clause; overlapping matches are consumed once (ranges before singles). */
export function yearsInClause(clause: string): YearsMatch[] {
  const c = clause.toLowerCase();
  const out: YearsMatch[] = [];
  const taken: Array<[number, number]> = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const take = (re: RegExp, min: (m: RegExpExecArray) => number) => {
    for (const m of c.matchAll(new RegExp(re.source, 'gi'))) {
      const a = m.index!;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      const v = min(m as RegExpExecArray);
      if (!Number.isFinite(v) || v < 0 || v > 15) continue;
      taken.push([a, b]);
      out.push({ min: v, text: clause.slice(a, b).trim() });
    }
  };
  // ranges: "2-4 years", "3-5 שנות ניסיון", "שנה-שנתיים", "שנתיים-שלוש"
  take(new RegExp(`(שנה|שנתיים|${N})\\s*(?:-|–|—|עד|to)\\s*(שנה|שנתיים|${N})\\s*\\+?\\s*${UNIT}?`), (m) => {
    const a = m[1] === 'שנה' ? 1 : m[1] === 'שנתיים' ? 2 : num(m[1]!);
    // a bare range without a unit must still be followed by a unit word somewhere (e.g. "3-4 שנים")
    if (!/שנ|year|yr/.test(m[0]) && !/שנה|שנתיים/.test(m[0])) return NaN;
    return a;
  });
  // "+3 שנים", "3+ years", "5+ yrs"
  take(new RegExp(`\\+\\s*${N}\\s*${UNIT}`), (m) => num(m[1]!));
  take(new RegExp(`${N}\\s*\\+\\s*${UNIT}`), (m) => num(m[1]!));
  // "שנתיים" / "לפחות שנה" / "ניסיון של שנה"
  take(/שנתיים/, () => 2);
  take(/(?:לפחות|של|מעל|מינימום)\s+שנה(?![א-ת])/, () => 1);
  // "at least 2 years", "minimum of 3 years", "לפחות 3 שנים", "3 שנות ניסיון", "ניסיון של 3 שנים"
  take(new RegExp(`${N}\\s*${UNIT}`), (m) => num(m[1]!));
  return out;
}

export function extractRequiredYears(text: string): ExperienceExtraction {
  const clauses = splitClauses(text);
  const matches: Array<YearsMatch & { clause: string }> = [];
  let juniorText: string | null = null;
  for (const clause of clauses) {
    const j = clause.match(JUNIOR);
    if (j && !juniorText && !ADVANTAGE.test(clause)) juniorText = clause.length > 140 ? `${clause.slice(0, 137)}…` : clause;
    if (ADVANTAGE.test(clause)) continue;
    if (NOT_CANDIDATE.test(clause)) continue;
    if (!EXPERIENCE_CONTEXT.test(clause)) continue;
    for (const m of yearsInClause(clause)) matches.push({ ...m, clause });
  }
  if (matches.length === 0) return { requiredYears: null, matches: [], text: null, juniorText };
  const top = matches.reduce((a, b) => (b.min > a.min ? b : a));
  const clause = top.clause.length > 160 ? `${top.clause.slice(0, 157)}…` : top.clause;
  return { requiredYears: top.min, matches: matches.map(({ min, text: t }) => ({ min, text: t })), text: clause, juniorText };
}

/** Text the extractor reads for a job: requirements, description, and the site's own experience field. */
export function experienceInput(job: { requirementsText: string; descriptionText: string; raw?: unknown }): string {
  const raw = (job.raw ?? {}) as { experience?: unknown };
  const siteField = typeof raw.experience === 'string' && raw.experience.trim() ? `\nניסיון: ${raw.experience.trim()}` : '';
  return `${job.requirementsText}\n${job.descriptionText}${siteField}`;
}
