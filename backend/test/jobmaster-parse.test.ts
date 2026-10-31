/**
 * JobMaster page parsers on sanitized copies of real pages (2026-10-31): search results, the job page, the "jobs I
 * applied to" list, the login state, the popup's preview (questions → plan fields) and the send payload check.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  loginState,
  optionValue,
  parseJobPage,
  parseSearchPage,
  parseSendResponse,
  parseSentList,
  payloadHasMultiSend,
  postedAt,
  previewFields,
  searchUrl,
  type JmPreview,
} from '../src/sites/jobmaster/parse.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const NOW = new Date('2026-10-31T20:00:00Z');

describe('search results', () => {
  const r = parseSearchPage(fx('jobmaster-search.html'), NOW);
  it('reads every card: key, title, company, location, short description, posted time; and the last page', () => {
    expect(r.jobs).toHaveLength(10);
    expect(r.lastPage).toBe(4);
    expect(r.jobs[0]).toMatchObject({
      site: 'jobmaster',
      externalId: '9887728',
      title: 'מפתח.ת Full Stack',
      company: 'קבוצת ניאופרם',
      location: 'פתח תקווה',
      url: 'https://www.jobmaster.co.il/jobs/checknum.asp?key=9887728',
      applyType: 'site_one_click',
      language: 'he',
      detailsFetched: false,
      postedAt: '2026-10-31T13:00:00.000Z',
    });
    expect(r.jobs[0]!.descriptionText).toMatch(/^חלק מצוות טכנולוגי/);
    expect(new Set(r.jobs.map((j) => j.externalId)).size).toBe(10);
  });
  it('search address', () => expect(searchUrl('Full Stack')).toBe('https://www.jobmaster.co.il/jobs/?q=Full+Stack'));
  it('posted times', () => {
    expect(postedAt('פורסם לפני 3 ימים', NOW)).toBe('2026-10-28T20:00:00.000Z');
    expect(postedAt('לפני שעה', NOW)).toBe('2026-10-31T19:00:00.000Z');
    expect(postedAt('לא ידוע', NOW)).toBeNull();
  });
});

describe('job page', () => {
  it('reads the full job, and whether it can be applied to on the site', () => {
    const j = parseJobPage(fx('jobmaster-job.html'), '9907567', NOW)!;
    expect(j).toMatchObject({ externalId: '9907567', title: 'AI Automation Specialist - QA', location: 'חיפה', applyType: 'site_one_click', detailsFetched: true });
    expect(j.company.length).toBeGreaterThan(1);
    expect(j.descriptionText.length).toBeGreaterThan(50);
    expect(j.raw).toMatchObject({ canApply: true });
  });
  it('another job key, or a removed job → null', () => {
    expect(parseJobPage(fx('jobmaster-job.html'), '1')).toBeNull();
    expect(parseJobPage('<html><body>המשרה אינה פעילה</body></html>', '9907567')).toBeNull();
  });
});

describe('login state and the applied list', () => {
  it('logged in = the logoff link; logged out = the login link', () => {
    expect(loginState(fx('jobmaster-job.html'))).toBe('logged_in');
    expect(loginState(fx('jobmaster-search.html'))).toBe('unknown');
    expect(loginState('<a aria-label="התחבר">התחבר</a>')).toBe('logged_out');
  });
  it('the "jobs I applied to" list: job keys with the date sent, the total and the pages', () => {
    const s = parseSentList(fx('jobmaster-sent-list.html'));
    expect(s.total).toBe(26);
    expect(s.lastPage).toBe(3);
    expect([...s.applied]).toEqual([
      ['9840924', '2026-09-05'],
      ['9840029', '2026-09-05'],
      expect.arrayContaining([expect.stringMatching(/^\d+$/), expect.stringMatching(/^2026-\d\d-\d\d$/)]),
    ]);
  });
});

describe('the popup: suitability questions (never answered by the model)', () => {
  const prev = JSON.parse(fx('jobmaster-prev.json')) as JmPreview;
  it('yes/no, years and level questions become plan fields', () => {
    expect(previewFields(prev)).toEqual([{ key: 'suitability.1655153', label: 'חי/ה את עולם ה-AI ומתנסה באופן יומיומי בכלים חדשים', type: 'yes_no', required: true }]);
    const more = previewFields({ ...prev, skills: [{ skillID: 1, qtype: 'Y', questiontext: 'React' }, { skillID: 2, qtype: 'L', questiontext: 'אנגלית' }, { skillID: 3, qtype: 'Z', questiontext: '?' }] });
    expect(more).toEqual([
      { key: 'suitability.1', label: 'כמה שנות ניסיון: React', type: 'number', required: true },
      { key: 'suitability.2', label: 'אנגלית', type: 'choice', required: true, options: ['רמה בסיסית', 'רמה בינונית', 'רמה גבוהה', 'רמה גבוהה מאוד'] },
      { key: 'suitability.3', label: '?', type: 'choice', required: true, options: undefined },
    ]);
  });
  it('planned answers map to the site option values; anything else → no match', () => {
    expect([optionValue('Q', 'yes'), optionValue('Q', 'no'), optionValue('Q', 'maybe')]).toEqual(['2', '1', null]);
    expect([optionValue('Y', '0'), optionValue('Y', '2'), optionValue('Y', '7'), optionValue('Y', '3 שנים')]).toEqual(['1', '2', '5', '3']);
    expect([optionValue('L', 'רמה גבוהה'), optionValue('L', 'high')]).toEqual(['3', null]);
  });
});

describe('the send', () => {
  it('a payload with "send to similar categories" is detected in every encoding the site uses', () => {
    expect(payloadHasMultiSend('jobnumber=1&korotVersionNum=5&multiSubcat=171&multiSendSes=y&isCheckedMultiSend=y')).toBe(true);
    expect(payloadHasMultiSend('jobnumber=1&isCheckedMultiSend=y')).toBe(true);
    expect(payloadHasMultiSend('------x\r\nContent-Disposition: form-data; name="multiSubcat"\r\n\r\n171')).toBe(true);
    expect(payloadHasMultiSend('jobnumber=1&korotVersionNum=5&slct1=2&letter=%25%25')).toBe(false);
    expect(payloadHasMultiSend(null)).toBe(false);
  });
  it('the send answer', () => {
    expect(parseSendResponse({ status: 'OK' })).toEqual({ kind: 'submitted' });
    expect(parseSendResponse({ status: 'ERROR', errText: 'errorloginnouser' })).toMatchObject({ kind: 'failed', needsLogin: true });
    expect(parseSendResponse(null)).toMatchObject({ kind: 'failed' });
  });
});
