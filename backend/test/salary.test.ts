import { describe, expect, it } from 'vitest';
import { composeSalaryAnswer, jobSalary, parseSalarySnippet, salaryFromBucket, salaryFromText, salarySettings, type PostedSalary } from '../src/core/salary.js';
import { marketStats, percentile, type MarketJob } from '../src/core/market.js';
import { prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { rankStoredJob } from '../src/core/rank.js';
import { resolveField, type ResolveDeps } from '../src/apply/resolve.js';
import { questionKey } from '../src/apply/classify.js';
import type { BankEntry } from '../src/apply/bank.js';

const range = (t: string) => {
  const s = salaryFromText(t);
  return s ? [s.min, s.max, s.unit] : null;
};

describe('posted salary parsing', () => {
  it('Hebrew ranges with commas, ₪ and ש"ח', () => {
    expect(range('שכר ותנאים: - 11,000-13,000 ₪, בהתאם לניסיון')).toEqual([11000, 13000, 'month']);
    expect(range('השכר: 12000 עד 15000 ש"ח ברוטו')).toEqual([12000, 15000, 'month']);
    expect(range('שכר בין 14,500 ל-17,000 ש״ח')).toEqual([14500, 17000, 'month']);
    expect(range('משכורת: 16,000 ₪')).toEqual([16000, 16000, 'month']);
  });

  it('k notation, and small ranges meaning thousands', () => {
    expect(range('SysAdmin ג׳וניור - שכר 11K-13K')).toEqual([11000, 13000, 'month']);
    expect(range('Salary: 15k-20k NIS gross')).toEqual([15000, 20000, 'month']);
    expect(range('ממוצע שכר 18K+++')).toEqual([18000, null, 'month']);
    expect(range('השכר ההתחלתי ינוע בין 8-10 תלוי ניסיון')).toEqual([8000, 10000, 'month']);
  });

  it('open ranges: from / up to', () => {
    expect(range('שכר: החל מ-14,000 ש"ח')).toEqual([14000, null, 'month']);
    expect(range('שכר עד 12,000')).toEqual([null, 12000, 'month']);
  });

  it('hourly pay is kept separately', () => {
    expect(range('מיקום: פתח תקווה | שכר: 50 ש"ח לשעה')).toEqual([50, 50, 'hour']);
    expect(range('שכר ותנאים: - 45 ₪ לשעה בהתחלה')).toEqual([45, 45, 'hour']);
    expect(range('שכר שעתי 40-48 ₪')).toEqual([40, 48, 'hour']);
  });

  it('ignores numbers that are not the salary', () => {
    for (const t of [
      'שכר גבוה עם עדכוני שכר קבועים לפי ותק, כרטיס תן ביס 50 ₪ לכל יום',
      'שכר ותנאים: - משרה מלאה, 08:00-17:00',
      'שכר ותנאים: - משרה מלאה, 3-4 ימים מהבית',
      'שכר: מעל המינימום + בונוסים',
      '6,000 ש"ח מענק התמדה. שכר בסיס + בונוס 2,000 ש"ח',
      'שכר 15 קבועים',
      'חשב/ת שכר מנוסה, 3 שנות ניסיון',
    ]) expect(range(t)).toBeNull();
  });

  it("Drushim's salary field wins; the search bucket is the last resort", () => {
    expect(jobSalary({ title: 'x', descriptionText: 'שכר 9000 בערך\n\nהיקף: משרה מלאה | ניסיון: 1-2 שנים | שכר: 10000-13000', requirementsText: '' })).toMatchObject({ min: 10000, max: 13000, source: 'drushim_field' });
    expect(jobSalary({ title: 'x', descriptionText: '', requirementsText: '', raw: { salaryRange: '25000-30000' } })).toMatchObject({ min: 25000, max: 30000, source: 'drushim_field' });
    expect(jobSalary({ title: 'x', descriptionText: 'ללא פרטים', requirementsText: '', raw: { salaryRangeId: 10001 } })).toMatchObject({ min: 10000, max: 13000, source: 'drushim_bucket' });
    expect(salaryFromBucket(null)).toBeNull();
    expect(parseSalarySnippet('30000+')).toEqual({ min: 30000, max: null, unit: 'month' });
  });
});

const prefs = (over: Record<string, unknown> = {}) =>
  PrefsSchema.parse({
    roleTypes: [
      { id: 'fullstack', tier: 1, queries: ['Full Stack'], titleKeywords: ['full stack'], salary: { floor: 16000 } },
      { id: 'qa', tier: 2, queries: ['QA'], titleKeywords: ['qa automation'] },
      { id: 'support', tier: 3, queries: ['תמיכה'], titleKeywords: ['תמיכה טכנית'] },
    ],
    salary: { default: { floor: 10000, textAnswerNoRange: 'גמיש', numericFallback: 14000 }, tier2: { floor: 13000 } },
    ...over,
  });

describe('salary settings and the floor', () => {
  it('role type → tier → default, per value', () => {
    const p = prefs();
    expect(salarySettings(p, p.roleTypes[0]!)).toMatchObject({ floor: 16000, textAnswerNoRange: 'גמיש', from: { floor: 'role:fullstack', textAnswerNoRange: 'default' } });
    expect(salarySettings(p, p.roleTypes[1]!)).toMatchObject({ floor: 13000, from: { floor: 'tier2' } });
    expect(salarySettings(p, p.roleTypes[2]!)).toMatchObject({ floor: 10000, from: { floor: 'default' } });
  });

  it('posted maximum below the floor → skipped_salary, with the range and the floor', () => {
    const job = (title: string, min: number, max: number) => ({ title, company: 'x', location: '', salaryMin: min, salaryMax: max, salaryUnit: 'month' });
    expect(prefilter(job('Full Stack Developer', 11000, 13000), prefs())).toEqual({
      pass: false,
      status: 'skipped_salary',
      reason: 'salary: posted 11,000–13,000 ₪ < floor 16,000 ₪ (role fullstack, role:fullstack)',
    });
    expect(prefilter(job('Full Stack Developer', 14000, 17000), prefs()).pass).toBe(true); // overlaps the floor
    expect(prefilter({ ...job('Full Stack Developer', 40, 50), salaryUnit: 'hour' }, prefs()).pass).toBe(true); // hourly: not compared
  });

  it('empty settings = no salary filtering', () => {
    const empty = prefs({ salary: {}, roleTypes: [{ id: 'fullstack', tier: 1, queries: ['x'], titleKeywords: ['full stack'] }] });
    expect(prefilter({ title: 'Full Stack Developer', company: 'x', location: '', salaryMin: 5000, salaryMax: 6000, salaryUnit: 'month' }, empty).pass).toBe(true);
  });

  it('salaryBoost when the posted range reaches the floor', () => {
    const p = prefs({ ranking: { salaryBoost: 7 } });
    const base = { title: 'Full Stack Developer', roleTypes: [], requiredYears: 1, juniorText: null };
    expect(rankStoredJob({ ...base, salaryMax: 18000, salaryUnit: 'month' }, { score: 80 }, p).salary).toBe(7);
    expect(rankStoredJob({ ...base, salaryMax: null, salaryUnit: null }, { score: 80 }, p).salary).toBe(0);
  });
});

describe('salary answers', () => {
  const posted = (min: number | null, max: number | null, unit: 'month' | 'hour' = 'month'): PostedSalary => ({ min, max, unit, source: 'drushim_field', text: '' });
  const st = (floor: number | null, text = '', num: number | null = null) => ({ floor, textAnswerNoRange: text, numericFallback: num, from: { floor: 'default', textAnswerNoRange: 'default', numericFallback: 'default' } });

  it('posted range, no floor → the upper half: X = midpoint rounded up to 500, Y = max; number = X', () => {
    expect(composeSalaryAnswer(posted(14000, 18000), st(null), 'text')).toMatchObject({ status: 'resolved', value: '16,000–18,000 ₪ ברוטו', basis: 'posted range' });
    expect(composeSalaryAnswer(posted(14000, 18000), st(null), 'number')).toMatchObject({ status: 'resolved', value: '16000' });
    expect(composeSalaryAnswer(posted(10000, 13000), st(null), 'text').value).toBe('11,500–13,000 ₪ ברוטו');
    expect(composeSalaryAnswer(posted(10000, 12600), st(null), 'number').value).toBe('11500'); // midpoint 11,300 → up to 11,500
    expect(composeSalaryAnswer(posted(12000, 12000), st(null), 'text').value).toBe('12,000 ₪ ברוטו');
  });

  it('a floor raises X when it is above the midpoint', () => {
    expect(composeSalaryAnswer(posted(14000, 18000), st(15200), 'text').value).toBe('16,000–18,000 ₪ ברוטו'); // midpoint wins
    expect(composeSalaryAnswer(posted(14000, 18000), st(17200), 'text').value).toBe('17,200–18,000 ₪ ברוטו');
    expect(composeSalaryAnswer(posted(14000, 18000), st(17200), 'number').value).toBe('17200');
  });

  it('only a minimum or a maximum posted → that value', () => {
    expect(composeSalaryAnswer(posted(16000, null), st(null), 'text').value).toBe('16,000 ₪ ברוטו');
    expect(composeSalaryAnswer(posted(16000, null), st(17000), 'text').value).toBe('17,000 ₪ ברוטו');
    expect(composeSalaryAnswer(posted(null, 12000), st(null), 'number').value).toBe('12000');
  });

  it('the prefilled default text answers when no range is posted; numbers stay pending', () => {
    const prefsFile = PrefsSchema.parse({ salary: { default: { textAnswerNoRange: 'גמיש, בהתאם להיקף התפקיד ולתנאים. אשמח לדבר על כך בשיחה' } } });
    const settings = salarySettings(prefsFile, null);
    expect(composeSalaryAnswer(null, settings, 'text')).toMatchObject({ status: 'resolved', value: 'גמיש, בהתאם להיקף התפקיד ולתנאים. אשמח לדבר על כך בשיחה', basis: 'fallback' });
    expect(composeSalaryAnswer(null, settings, 'number')).toMatchObject({ status: 'pending', basis: 'pending' });
  });

  it('no posted range → fallbacks; both empty → pending', () => {
    expect(composeSalaryAnswer(null, st(null, 'גמיש, בהתאם להיקף התפקיד ולתנאים', 15000), 'text')).toMatchObject({ value: 'גמיש, בהתאם להיקף התפקיד ולתנאים', basis: 'fallback' });
    expect(composeSalaryAnswer(null, st(null, '', 15000), 'number')).toMatchObject({ value: '15000', basis: 'fallback' });
    expect(composeSalaryAnswer(null, st(null), 'text')).toMatchObject({ status: 'pending', basis: 'pending' });
    expect(composeSalaryAnswer(posted(45, 45, 'hour'), st(null), 'number').detail).toMatch(/only an hourly rate/);
  });

  it('in field resolution: empty settings → pending (never the LLM); an answer you gave in the bank still counts', async () => {
    const bank: BankEntry[] = [];
    const d = (b: BankEntry[]): ResolveDeps => ({
      profile: null,
      bank: { byKey: (k) => b.find((e) => e.normKey === k) ?? null, active: () => b },
      matchBank: async () => ({ entryId: null, confidence: 0 }),
      draft: async () => {
        throw new Error('the LLM must not be asked');
      },
      minConfidence: 0.85,
      job: { title: 'Full Stack', text: '', language: 'he' },
      salary: { posted: null, settings: st(null) },
    });
    const field = { key: 's', label: 'מהן ציפיות השכר שלך?', type: 'text' as const, required: true };
    expect(await resolveField(field, d(bank))).toMatchObject({ status: 'pending', reason: expect.stringMatching(/^salary: no salary posted/) });
    const answered: BankEntry = { id: 1, question: field.label, normKey: questionKey(field.label), answer: '17,000', type: 'text', options: null, language: 'he', status: 'active', usageCount: 0, source: 'user', createdAt: '', updatedAt: '', lastUsedAt: null };
    expect(await resolveField(field, d([answered]))).toMatchObject({ status: 'resolved', value: '17,000', provenance: { source: 'bank' } });
    const withRange = { ...d([answered]), salary: { posted: posted(15000, 19000), settings: st(16000) } };
    expect(await resolveField(field, withRange)).toMatchObject({ value: '17,000–19,000 ₪ ברוטו', provenance: { source: 'salary', ref: 'posted range' } });
  });
});

describe('market stats', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const job = (title: string, min: number, max: number, years: number | null, daysAgo = 1): MarketJob => ({
    title,
    roleTypes: [],
    requiredYears: years,
    salaryMin: min,
    salaryMax: max,
    salaryUnit: 'month',
    firstSeenAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
  });

  it('percentiles, buckets by required years, % below the floor, sample-size warning, time window', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    const jobs = [
      job('Full Stack Developer', 10000, 12000, 1),
      job('Full Stack Developer', 14000, 16000, 1),
      job('Full Stack Developer', 18000, 22000, 2),
      job('Full Stack Developer', 13000, 15000, null),
      job('Full Stack Developer', 30000, 40000, 1, 45), // outside 30 days
      { ...job('QA Automation Engineer', 40, 50, 1), salaryUnit: 'hour' },
    ];
    const r = marketStats(jobs, prefs(), { days: 30, now });
    expect(r).toMatchObject({ jobsInWindow: 5, withMonthlySalary: 4, hourlyOnly: 1 });
    const all = r.buckets.find((b) => b.roleType === 'fullstack' && b.years === 'all')!;
    // midpoints 11000, 15000, 20000, 14000 → sorted 11000, 14000, 15000, 20000; maxima 12000, 16000, 22000, 15000 → 2 of 4 below 16000
    expect(all).toMatchObject({ count: 4, min: 11000, max: 20000, median: 14500, p25: 13300, p75: 16300, floor: 16000, belowFloorPct: 50, suggestedFloor: 13500, lowSample: true });
    expect(r.buckets.filter((b) => b.roleType === 'fullstack').map((b) => [b.years, b.count])).toEqual([
      ['all', 4],
      ['0–1', 2],
      ['2', 1],
      ['not stated', 1],
    ]);
    expect(marketStats(jobs, prefs(), { days: 60, now }).withMonthlySalary).toBe(5);
  });
});
