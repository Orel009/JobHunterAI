import { describe, expect, it } from 'vitest';
import { excludedCompanyMatch, leadRoleNoun, prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { refilterExisting } from '../src/pipeline/runner.js';
import { resolveField, type ResolveDeps } from '../src/apply/resolve.js';
import { questionKey } from '../src/apply/classify.js';
import type { BankEntry } from '../src/apply/bank.js';
import type { PostedSalary } from '../src/core/salary.js';

const prefs = PrefsSchema.parse({ filters: { includeTitleKeywords: ['developer', 'מפתח', 'מוביל', 'מובילה', 'תמיכה'], excludeCompanies: ['matrix', 'מטריקס'] } });
const job = (title: string, company = 'Acme') => ({ title, company, location: '' });

describe('"מוביל/ת" as a lead role vs. "מוביל" as an adjective (titles from real posts)', () => {
  it.each([
    'מוביל.ת צוות תוכנה - 13542',
    'מוביל/ה הנדסת מערכת תוכנה RT או WEB - 976477',
    'מוביל/ת חדשנות ו-AI, חולון/באר שבע',
    'מוביל/ה טכנולוגי/ת QA & Automation משולב AI',
    'מהנדס/ת FAE מוביל/ה בתחום Embedded System',
    'דרוש/ה מובילה טכנולוגית',
    'Full Stack Developer - מובילה צוות פיתוח',
  ])('lead role, skipped: %s', (t) => {
    expect(leadRoleNoun(t)).not.toBeNull();
    expect(prefilter(job(t), prefs)).toMatchObject({ pass: false, reason: expect.stringMatching(/^seniority: ".+" \(team \/ domain lead\)$/) });
  });

  it.each([
    'Full Stack Developer jounior לארגון פיננסי מוביל',
    'לחברה מובילה דרוש/ה ר"צ DevOps מומחה AI!',
    'מפתח/ת DevOps לחברה טכנולוגית מובילה- שכר גבוה!',
    'לחברה מובילה טכנולוגית דרוש/ה מפתח/ת',
    'חברה מובילה בתחום עיבוד שבבי מגייסת מבקר/ת איכות',
    'איש/אשת תמיכה טכנית חברה מובילה בתחומה!',
    'מפתח/ת Backend Node.js בארגון פיננסי מוביל',
    'מעצב/ת UX/UI לבית תוכנה מוביל בר"ג !',
  ])('adjective, kept: %s', (t) => {
    expect(leadRoleNoun(t)).toBeNull();
    expect(prefilter(job(t), prefs).reason).not.toMatch(/seniority/);
  });
});

describe('excluded companies', () => {
  it('whole words, case-insensitive, Hebrew and English names', () => {
    for (const c of ['Matrix R&D Services', 'matrix (בנקאות)', 'צפון matrix', 'MATRIX', 'מטריקס אי.טי']) expect(excludedCompanyMatch(c, prefs.filters.excludeCompanies)).not.toBeNull();
    for (const c of ['Matrixx Labs', 'Acme', 'חסוי']) expect(excludedCompanyMatch(c, prefs.filters.excludeCompanies)).toBeNull();
    expect(prefilter(job('Full Stack Developer', 'matrix (פינטק)'), prefs)).toEqual({ pass: false, status: 'skipped_company', reason: 'excluded company: matrix (פינטק) (matches "matrix")' });
  });

  it('saving preferences re-checks existing jobs: skipped_company, and back when the company is removed', () => {
    const db = openDb(':memory:');
    const repo = new Repo(db);
    const raw = { site: 'drushim' as const, externalId: '1', company: 'matrix (בנקאות)', title: 'Full Stack Developer', location: '', descriptionText: '', requirementsText: '', url: 'u', postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {} };
    repo.upsertJob(toJob(raw));
    const id = toJob(raw).id;
    const none = PrefsSchema.parse({ filters: { includeTitleKeywords: ['developer'] } });
    refilterExisting(repo, none);
    expect(repo.getJob(id)!.status).toBe('discovered');
    expect(refilterExisting(repo, prefs)).toMatchObject({ newlySkipped: 1 });
    expect(repo.getJob(id)).toMatchObject({ status: 'skipped_company', statusReason: 'excluded company: matrix (בנקאות) (matches "matrix")' });
    expect(refilterExisting(repo, none)).toMatchObject({ restored: 1 });
    expect(repo.getJob(id)!.status).toBe('discovered');
  });
});

describe('salary: posted range vs. an answer in the bank', () => {
  const settings = { floor: null, textAnswerNoRange: 'גמיש, בהתאם להיקף התפקיד ולתנאים. אשמח לדבר על כך בשיחה', numericFallback: null, from: { floor: 'unset', textAnswerNoRange: 'default', numericFallback: 'unset' } };
  const field = { key: 's', label: 'מהן ציפיות השכר שלך?', type: 'text' as const, required: true };
  const mine: BankEntry = { id: 7, question: field.label, normKey: questionKey(field.label), answer: '18,000 ₪', type: 'text', options: null, language: 'he', status: 'active', usageCount: 0, source: 'user', createdAt: '', updatedAt: '', lastUsedAt: null };
  const deps = (posted: PostedSalary | null, bank: BankEntry[]): ResolveDeps => ({
    profile: null,
    bank: { byKey: (k) => bank.find((e) => e.normKey === k) ?? null, active: () => bank },
    matchBank: async () => ({ entryId: null, confidence: 0 }),
    draft: async () => {
      throw new Error('the LLM must not be asked');
    },
    minConfidence: 0.85,
    job: { title: 'x', text: '', language: 'he' },
    salary: { posted, settings },
  });
  const range: PostedSalary = { min: 10000, max: 13000, unit: 'month', source: 'drushim_field', text: 'שכר: 10000-13000' };

  it('a posted range wins over my bank answer (upper half)', async () => {
    expect(await resolveField(field, deps(range, [mine]))).toMatchObject({ value: '11,500–13,000 ₪ ברוטו', provenance: { source: 'salary', ref: 'posted range' } });
  });
  it('no posted range: my bank answer comes before textAnswerNoRange', async () => {
    expect(await resolveField(field, deps(null, [mine]))).toMatchObject({ value: '18,000 ₪', provenance: { source: 'bank', ref: '7' } });
  });
  it('no posted range and nothing in the bank: textAnswerNoRange; a number-only field waits', async () => {
    expect(await resolveField(field, deps(null, []))).toMatchObject({ value: settings.textAnswerNoRange, provenance: { source: 'salary', ref: 'fallback' } });
    expect(await resolveField({ ...field, type: 'number' }, deps(null, []))).toMatchObject({ status: 'pending', reason: expect.stringMatching(/^salary: no salary posted/) });
  });
});
