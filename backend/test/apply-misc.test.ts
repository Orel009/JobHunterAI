import { describe, expect, it } from 'vitest';
import { checkDraftCitations, relevantFacts } from '../src/apply/draft.js';
import { chooseCv, hebrewRatio } from '../src/apply/cv.js';
import { AnswersBank, yesNo } from '../src/apply/bank.js';
import { readiness, drushimFieldsFromJob } from '../src/apply/plan.js';
import { parseSendCvResponse, appliedJobsFromUserdata } from '../src/sites/drushim/apply-parse.js';
import { openDb } from '../src/db/index.js';
import { PrefsSchema } from '../src/core/prefs.js';
import type { ResolvedField } from '../src/apply/types.js';
import type { StoredJob } from '../src/db/repo.js';
import fs from 'node:fs';

describe('draft post-check', () => {
  const known = new Set(['exp.acme', 'skill.react', 'summary.he']);
  it('rejects unanswerable, empty, uncited and unknown citations', () => {
    expect(checkDraftCitations({ text: '', usedFactIds: [], unanswerable: true }, known)).toMatch(/unanswerable/);
    expect(checkDraftCitations({ text: '  ', usedFactIds: ['exp.acme'], unanswerable: false }, known)).toMatch(/empty/);
    expect(checkDraftCitations({ text: 'x', usedFactIds: [], unanswerable: false }, known)).toMatch(/cites no facts/);
    expect(checkDraftCitations({ text: 'x', usedFactIds: ['exp.acme', 'exp.ghost'], unanswerable: false }, known)).toMatch(/exp\.ghost/);
  });
  it('accepts drafts citing only known facts', () => {
    expect(checkDraftCitations({ text: 'x', usedFactIds: ['exp.acme', 'skill.react'], unanswerable: false }, known)).toBeNull();
  });
  it('relevant facts exclude contact data and keep role headers', () => {
    const facts = relevantFacts(
      [
        { id: 'contact.phone', text: 'Phone: 050' },
        { id: 'exp.acme', text: 'work: Dev at Acme' },
        { id: 'exp.acme.en.1', text: 'Built React dashboards' },
        { id: 'skill.go', text: 'Skill: Go' },
      ],
      'Tell us about React',
      'React developer',
    );
    expect(facts.map((x) => x.id)).toEqual(['exp.acme', 'exp.acme.en.1']);
  });
});

describe('CV language rule', () => {
  const cv = { he: 'קורות חיים.pdf', en: 'Resume.pdf' };
  it('Hebrew post with English tech terms → Hebrew CV', () => {
    const job = { title: 'מפתח/ת Full Stack', descriptionText: 'לחברה מובילה דרוש מפתח עם ניסיון ב-React, Node.js, AWS ו-Docker', requirementsText: '3 שנות ניסיון' };
    expect(chooseCv(job, cv, 0.2)).toMatchObject({ lang: 'he', cvName: 'קורות חיים.pdf' });
  });
  it('English post → English CV, ratio stored', () => {
    const job = { title: 'Backend Engineer', descriptionText: 'We are looking for a backend engineer with Python and AWS experience.', requirementsText: '' };
    const c = chooseCv(job, cv, 0.2);
    expect(c).toMatchObject({ lang: 'en', cvName: 'Resume.pdf', hebrewRatio: 0, threshold: 0.2 });
  });
  it('mostly English with a little Hebrew stays English below the threshold', () => {
    expect(hebrewRatio('Senior Python developer for a fintech company in תל אביב')).toBeLessThan(0.2);
  });
});

describe('already applied / send result', () => {
  it('Failed entry with SentDate for this job → already applied', () => {
    expect(parseSendCvResponse({ Successful: [], Failed: [{ JobCode: 123, SentDate: '2026-10-01T10:00:00' }], IsError: false }, 123)).toEqual({ kind: 'already_applied', sentDate: '2026-10-01T10:00:00' });
  });
  it('success', () => {
    expect(parseSendCvResponse({ Successful: [{ JobCode: 123 }], Failed: [], IsError: false }, 123)).toEqual({ kind: 'submitted' });
  });
  it('daily limit is fatal for the day; auth errors need login', () => {
    expect(parseSendCvResponse({ IsError: true, Errors: { ExceededDailyCvSubmissionsLimit: 'x' } }, 1)).toMatchObject({ kind: 'error', fatalForDay: true });
    expect(parseSendCvResponse({ IsError: true, Errors: { TokenExpired: 'x' } }, 1)).toMatchObject({ kind: 'error', needsLogin: true });
    expect(parseSendCvResponse({}, 1)).toMatchObject({ kind: 'error', key: 'send_cv_failed' });
  });
  it('applied jobs = the keys of userdata JobHistory (sanitized live response), with the sent date', () => {
    const ud = JSON.parse(fs.readFileSync(new URL('./fixtures/drushim-userdata.json', import.meta.url), 'utf8'));
    const m = appliedJobsFromUserdata(ud);
    expect([...m.keys()]).toEqual(['39000001', '39000002', '39000003']);
    expect(m.get('39000003')).toMatch(/^2026-10-31T/);
    expect(appliedJobsFromUserdata(null).size).toBe(0);
    expect(appliedJobsFromUserdata({ UserProfile: {} }).size).toBe(0);
  });
  it('the live success response of a real submission parses as submitted', () => {
    const r = JSON.parse(fs.readFileSync(new URL('./fixtures/drushim-sendcv-success.json', import.meta.url), 'utf8'));
    expect(parseSendCvResponse(r, r.Successful[0].JobCode)).toEqual({ kind: 'submitted' });
  });
});

describe('answers bank', () => {
  it('seeds standard answers, pending when empty, never overwriting user edits', () => {
    const bank = new AnswersBank(openDb(':memory:'));
    bank.seed(PrefsSchema.parse({ standardAnswers: { fullTime: true, salaryExpectation: '', shifts: 'לא' } }));
    const all = bank.list();
    expect(all.find((e) => e.question.includes('משרה מלאה'))).toMatchObject({ answer: 'כן', status: 'active', type: 'yes_no' });
    expect(all.find((e) => e.question.includes('ציפיות השכר'))).toMatchObject({ status: 'pending' });
    const shifts = all.find((e) => e.question.includes('משמרות'))!;
    bank.update(shifts.id, { answer: 'כן' });
    bank.seed(PrefsSchema.parse({ standardAnswers: { shifts: 'לא' } }));
    expect(bank.get(shifts.id)!.answer).toBe('כן');
  });
  it('pending questions are stored once (gender variants share a key)', () => {
    const bank = new AnswersBank(openDb(':memory:'));
    bank.addPending('האם את/ה מוכן/ה לעבוד במשמרות?', 'yes_no');
    bank.addPending('האם את מוכן לעבוד במשמרות?', 'yes_no');
    expect(bank.list({ status: 'pending' })).toHaveLength(1);
  });
  it('yesNo understands Hebrew and English', () => {
    expect(yesNo('כן')).toBe('yes');
    expect(yesNo('No')).toBe('no');
    expect(yesNo('אולי')).toBeNull();
  });
});

describe('plan readiness + Drushim fields', () => {
  const rf = (o: Partial<ResolvedField>): ResolvedField => ({
    field: { key: 'k', label: 'q', type: 'yes_no', required: true }, normKey: 'q', status: 'resolved', value: 'yes', provenance: { source: 'bank' }, ...o,
  });
  it('a required statement answered "no" blocks the application', () => {
    expect(readiness([rf({}), rf({ value: 'no' })])).toBe('blocked_no');
    expect(readiness([rf({}), rf({ status: 'pending', value: null })])).toBe('needs_answers');
    expect(readiness([rf({}), rf({ status: 'draft', field: { key: 'x', label: 'x', type: 'textarea', required: true }, value: 'txt' })])).toBe('has_drafts');
    expect(readiness([rf({})])).toBe('ready');
  });
  it('screening statements from job data become required yes/no fields', () => {
    const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/drushim-filter-questions.json', import.meta.url), 'utf8')) as Array<{ filterQuestions: string[] }>;
    const fields = drushimFieldsFromJob({ raw: { filterQuestions: fx[0]!.filterQuestions } } as unknown as StoredJob);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ key: 'screening.0', type: 'yes_no', required: true });
  });
});

describe('standard questions follow the candidate gender', () => {
  const prefs = PrefsSchema.parse({ standardAnswers: { availability: '', fullTime: true, shifts: 'לא', applyConsent: true } });
  it('female, male and neutral forms', () => {
    const f = new AnswersBank(openDb(':memory:'));
    f.seed(prefs, 'female');
    const qf = f.list().map((e) => e.question);
    expect(qf).toEqual(expect.arrayContaining(['מתי תוכלי להתחיל לעבוד?', 'האם את מעוניינת במשרה מלאה?', 'האם את מוכנה לעבוד במשמרות?']));
    expect(qf.some((q) => q.startsWith('אני מאשרת'))).toBe(true);
    expect(qf.join(' ')).not.toMatch(/אתה|תוכל |מעוניין |מוכן /);
    const m = new AnswersBank(openDb(':memory:'));
    m.seed(prefs, 'male');
    expect(m.list().map((e) => e.question)).toContain('האם אתה מעוניין במשרה מלאה?');
    const n = new AnswersBank(openDb(':memory:'));
    n.seed(prefs);
    expect(n.list().map((e) => e.question)).toContain('האם את/ה מעוניין/ת במשרה מלאה?');
  });
  it('changing the gender replaces the seeded questions, keeps user answers', () => {
    const bank = new AnswersBank(openDb(':memory:'));
    bank.seed(prefs, 'male');
    const shifts = bank.list().find((e) => e.question.includes('משמרות'))!;
    bank.update(shifts.id, { answer: 'כן' }); // user-edited: stays as is
    bank.seed(prefs, 'female');
    const qs = bank.list().map((e) => e.question);
    expect(qs).toContain('האם את מעוניינת במשרה מלאה?');
    expect(qs).not.toContain('האם אתה מעוניין במשרה מלאה?');
    expect(bank.list().filter((e) => e.question.includes('משרה מלאה'))).toHaveLength(1);
  });
});
