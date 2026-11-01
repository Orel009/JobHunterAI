/**
 * JobKarov, the pure parts: the job data embedded in a search page (sanitized live capture, 2026-11-01), the city
 * filter from your locations, the apply preview (company site / already sent / the form), the questions and their
 * fixed answer sets, the salary range, the send request check ("similar jobs" must be "no") and the send response.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  cityIdsFor,
  experienceBucket,
  optionAccepted,
  optionIdFor,
  parseCities,
  parseSearchPage,
  parseSendResponse,
  payloadFields,
  payloadProblems,
  postedAt,
  previewFields,
  previewKind,
  rangeIdFor,
  searchUrl,
  type JkPreview,
} from '../src/sites/jobkarov/parse.js';
import { experienceInput, extractRequiredYears } from '../src/core/experience.js';
import { prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { isConfirmation } from '../src/apply/plan.js';
import { cvNamesFor } from '../src/apply/cv-names.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const preview = () => JSON.parse(fx('jobkarov-preview.json')) as JkPreview;
/** the site's question shape (sfq_text, sfq_sfqc_id = answer set, accepted option ids), as its send form reads it */
const withQuestions = (qs: JkPreview['questions'], range = 0): JkPreview => {
  const p = preview();
  return { ...p, questions: qs, Site: { ...p.Site!, require_range: range } };
};

describe('search page', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const r = parseSearchPage(fx('jobkarov-search.html'), now);

  it('every job from the embedded data, normalized like the other sites (no job page needed)', () => {
    expect(r.jobs).toHaveLength(10);
    expect(r.found).toBe(278);
    const j = r.jobs.find((x) => x.externalId === '2766134')!;
    expect(j).toMatchObject({ site: 'jobkarov', detailsFetched: true, applyType: 'site_one_click', applyTarget: '', language: 'he' });
    expect(j.url).toMatch(/^https:\/\/www\.jobkarov\.com\/Search\/Site\/2766134\/\d+$/);
    expect(j.title.length).toBeGreaterThan(3);
    expect(j.location).toBeTruthy();
    expect(j.descriptionText.length).toBeGreaterThan(50);
    expect(j.requirementsText).toMatch(/ניסיון: 1-2 שנים$/);
  });

  it('the years-of-experience line goes to the experience extractor', () => {
    const j = r.jobs.find((x) => x.externalId === '2766134')!;
    expect(extractRequiredYears(experienceInput(j)).requiredYears).toBe(1);
    expect(extractRequiredYears('ניסיון: 3-5 שנים').requiredYears).toBe(3);
    expect(extractRequiredYears('ניסיון: מעל 5 שנים').requiredYears).toBe(5);
    expect(extractRequiredYears('ניסיון: ללא נסיון').requiredYears).toBeNull();
  });

  it('a company-site job → external with its link (review queue, no automation)', () => {
    const ext = r.jobs.find((x) => x.externalId === '2742308')!;
    expect(ext.applyType).toBe('external');
    expect(ext.applyTarget).toMatch(/^https:\/\//);
  });

  it('jobs this account already sent a CV to (sent / jSent.send_date) are listed as applied', () => {
    expect([...r.applied]).toEqual([['2768407', '2026-10-20']]);
    expect((r.jobs.find((x) => x.externalId === '2768407')!.raw as { sent: boolean }).sent).toBe(true);
  });

  it('a job without a company name keeps an empty company (no dedupe on it)', () => {
    expect(r.jobs.find((x) => x.externalId === '2655756')!.company).toBe('');
  });

  it('"עודכן היום" / "פורסם השבוע" → an approximate date', () => {
    expect(postedAt('עודכן היום', now)).toBe(now.toISOString());
    expect(postedAt('פורסם השבוע', now)).toBe(new Date(now.getTime() - 7 * 86_400_000).toISOString());
    expect(postedAt('', now)).toBeNull();
  });

  it('card locations pass your location filter by city', () => {
    const prefs = PrefsSchema.parse({ locations: ['נתניה', 'השרון', 'רעננה'], roleTypes: [{ id: 'x', tier: 1, queries: ['x'], titleKeywords: [] }] });
    const raanana = r.jobs.find((x) => x.location === 'רעננה')!;
    expect(prefilter({ title: 'Full Stack Developer', company: 'x', location: raanana.location }, prefs).reason).not.toMatch(/location/);
    expect(prefilter({ title: 'Full Stack Developer', company: 'x', location: 'באר שבע' }, prefs).reason).toMatch(/location/);
  });
});

describe('city filter from your locations', () => {
  const cities = parseCities(fx('jobkarov-cities.json'));
  it('reads the site city list', () => {
    expect(cities.find((c) => c.id === 1657)).toEqual({ id: 1657, name: 'נתניה' });
    expect(cities.find((c) => c.id === 1997)!.name).toBe('תל אביב - יפו');
  });
  it('same name, or one inside the other as whole words (the location filter rule)', () => {
    const m = cityIdsFor(['נתניה', 'השרון', 'תל אביב', 'אילת'], cities);
    expect(m.ids).toEqual(expect.arrayContaining([1657, 358, 1897, 1555, 1997, 3149]));
    expect(m.ids).not.toContain(421); // חיפה
    expect(m.ids).not.toContain(270); // גבעת שמואל: not "גבעתיים"
    expect(m.unmatched).toEqual(['אילת']);
  });
  it('the search address: query, cities[], newest first', () => {
    expect(searchUrl('Full Stack', [1657, 376])).toBe('https://www.jobkarov.com/Search/?query=Full%20Stack&cities[]=1657&cities[]=376&order=4');
  });
});

describe('apply preview', () => {
  it('company site / already sent / error / the form', () => {
    expect(previewKind({ status: 0, result: 'https://careers.example.com/x' })).toEqual({ kind: 'external', url: 'https://careers.example.com/x' });
    expect(previewKind({ status: 0, result: 'כבר שלחת קורות חיים למשרה זו, בתאריך 20/10/2026' })).toEqual({ kind: 'already_sent', date: '20/10/2026' });
    expect(previewKind({ status: 0, result: 'משרה זו אינה קיימת' }).kind).toBe('error');
    expect(previewKind(preview())).toEqual({ kind: 'form' });
    expect(previewKind({ ...preview(), Sent: '2026-10-20' })).toEqual({ kind: 'already_sent', date: '2026-10-20' });
  });

  it('a job without questions or salary range → no fields; "קצת על עצמי" is never a field (always empty)', () => {
    expect(previewFields(preview())).toEqual([]);
  });

  it('questions with fixed answer sets → plan fields; keys are questions, not statements to confirm', () => {
    const p = withQuestions(
      [
        { sfq_text: 'כמה שנות ניסיון בפיתוח תוכנה', sfq_sfqc_id: '1' },
        { sfq_text: 'ניסיון ב-React', sfq_sfqc_id: 1 },
        { sfq_text: 'רמת אנגלית', sfq_sfqc_id: '2' },
        { sfq_text: 'האם יש לך רישיון נהיגה', sfq_sfqc_id: '3' },
      ],
      1,
    );
    const f = previewFields(p);
    expect(f.map((x) => [x.key, x.type])).toEqual([
      ['suitability.q0', 'number'],
      ['suitability.q1', 'number'],
      ['suitability.q2', 'choice'],
      ['suitability.q3', 'yes_no'],
      ['salaryRange', 'number'],
    ]);
    expect(f[0]!.label).toBe('כמה שנות ניסיון בפיתוח תוכנה');
    expect(f[1]!.label).toBe('כמה שנות ניסיון: ניסיון ב-React');
    expect(f[2]!.options).toEqual(['ללא', 'חלש', 'בינוני', 'טוב', 'טוב מאוד', 'מצויין']);
    expect(f[4]!.label).toMatch(/שכר/);
    expect(f.some(isConfirmation)).toBe(false);
  });

  it('years → the site buckets (2 years → "up to 2 years")', () => {
    expect([0, 0.5, 1, 2, 2.9, 3, 5, 5.5, 6, 12].map(experienceBucket)).toEqual(['ללא נסיון', 'ללא נסיון', 'עד שנתיים', 'עד שנתיים', 'עד שנתיים', '3-5 שנים', '3-5 שנים', '3-5 שנים', 'מעל 5 שנים', 'מעל 5 שנים']);
  });

  it('planned answers → option ids; the employer accepted answers', () => {
    const p = withQuestions([
      { sfq_text: 'כמה שנות ניסיון', sfq_sfqc_id: '1', sfq_option_valid_answer: '2,3,4' },
      { sfq_text: 'רמת אנגלית', sfq_sfqc_id: '2' },
      { sfq_text: 'רישיון', sfq_sfqc_id: '3', sfq_option_valid_answer: ['11'] },
    ]);
    expect(optionIdFor(p, 0, '2')).toBe('2');
    expect(optionIdFor(p, 0, '0')).toBe('1');
    expect(optionIdFor(p, 0, '7')).toBe('4');
    expect(optionIdFor(p, 1, 'טוב מאוד')).toBe('9');
    expect(optionIdFor(p, 1, 'great')).toBeNull();
    expect(optionIdFor(p, 2, 'no')).toBe('12');
    expect(optionAccepted(p.questions![0]!, '2')).toBe(true);
    expect(optionAccepted(p.questions![0]!, '1')).toBe(false);
    expect(optionAccepted(p.questions![1]!, '5')).toBe(true);
    expect(optionAccepted(p.questions![2]!, '12')).toBe(false);
  });

  it('salary: the closest range (a boundary → the range that starts there)', () => {
    const R = preview().Ranges;
    expect(R!['7']).toBe('12000-15000');
    expect(rangeIdFor(14000, R)).toBe('7');
    expect(rangeIdFor(10000, R)).toBe('6');
    expect(rangeIdFor(2500, R)).toBe('1');
    expect(rangeIdFor(40000, R)).toBe('13');
    expect(rangeIdFor(0, R)).toBeNull();
    expect(rangeIdFor(NaN, R)).toBeNull();
  });
});

describe('the send request', () => {
  const multipart = (f: Record<string, string>) =>
    Object.entries(f)
      .map(([k, v]) => `------B\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('') + '------B--\r\n';
  const ok = { fname: 'טסט', lname: 'טסטוב', my_description: '', SiteID: '2768407', range: '0', fu1: '', multi: '2', cv: '5550002', answers: '-1,-1,-1' };

  it('reads multipart, url-encoded and JSON bodies', () => {
    expect(payloadFields(multipart(ok))).toMatchObject({ multi: '2', cv: '5550002', my_description: '' });
    expect(payloadFields('multi=2&cv=5550002&my_description=')).toMatchObject({ multi: '2', cv: '5550002', my_description: '' });
    expect(payloadFields(JSON.stringify(ok))).toMatchObject({ multi: '2', cv: '5550002' });
  });

  it('"similar jobs" must be "no", "about me" empty, the planned CV, no upload — otherwise aborted', () => {
    expect(payloadProblems(multipart(ok), { cvId: '5550002' })).toEqual([]);
    expect(payloadProblems(multipart({ ...ok, multi: '1' }), { cvId: '5550002' })[0]).toMatch(/similar jobs/);
    expect(payloadProblems(multipart({ ...ok, multi: '' }), { cvId: '5550002' })[0]).toMatch(/similar jobs/);
    const { multi: _m, ...noMulti } = ok;
    expect(payloadProblems(multipart(noMulti), { cvId: '5550002' })[0]).toMatch(/similar jobs/);
    expect(payloadProblems(multipart({ ...ok, my_description: 'hello' }), { cvId: '5550002' })).toEqual(['"קצת על עצמי" is not empty']);
    expect(payloadProblems(multipart(ok), { cvId: '5550001' })[0]).toMatch(/not the planned one/);
  });
});

describe('the send response', () => {
  it('sent / CAPTCHA (never attempted) / no longer current / already sent / other', () => {
    expect(parseSendResponse({ status: 1 })).toEqual({ kind: 'submitted' });
    expect(parseSendResponse({ status: 1, showmsg: 1, result: 'שגיאה' }).kind).toBe('failed');
    expect(parseSendResponse({ error: 'send captcha' })).toMatchObject({ kind: 'needs_manual', reason: 'captcha' });
    expect(parseSendResponse({ status: 0, result: 'notActuel' })).toMatchObject({ kind: 'expired' });
    expect(parseSendResponse({ status: 0, result: 'כבר שלחת קורות חיים למשרה זו' })).toMatchObject({ kind: 'already_applied' });
    expect(parseSendResponse(null)).toMatchObject({ kind: 'failed' });
  });
});

describe('Preferences', () => {
  it('JobKarov CV names by the stored file name; missing → empty (the application fails, no fallback)', () => {
    const p = PrefsSchema.parse({ cv: { he: 'a.pdf', en: 'b.pdf' }, jobkarov: { cv: { en: 'Test Person - Resume' } } });
    expect(cvNamesFor('jobkarov', p)).toMatchObject({ he: '', en: 'Test Person - Resume', where: expect.stringMatching(/jobkarov\.cv/) });
  });
});
