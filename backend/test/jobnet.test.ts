/**
 * Jobnet parsers and rules on sanitized copies of real pages (2026-10-31): results / job page (schema.org
 * JobPosting), the "you sent a CV" mark, the send form's login state, region → location mapping (approximate),
 * and the send-request checks (no opt-in, the planned CV).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseJobPage, parseResults, regionAccepted } from '../src/sites/jobnet/parse.js';
import { payloadFileName, payloadOptIns, parseSendResult, sendFormLoginState } from '../src/sites/jobnet/apply.js';
import { prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

describe('results and job page', () => {
  const r = parseResults(fx('jobnet-results.html'));
  it('reads every card with the full description, requirements, regions and sub-areas', () => {
    expect(r.total).toBe(21);
    expect(r.pages).toBe(3);
    expect(r.jobs).toHaveLength(15);
    const j = r.jobs[0]!;
    expect(j).toMatchObject({ site: 'jobnet', externalId: '13551358', title: 'Full Stack Developer', company: 'SQLink', postedAt: '2026-10-31', applyType: 'site_one_click', detailsFetched: true, url: 'https://www.jobnet.co.il/jobs?positionid=13551358' });
    expect(j.descriptionText).toMatch(/^מפתח\/ת Full Stack עבור ארגון ביטוח/);
    expect(j.requirementsText).toMatch(/^- 3 שנות ניסיון/);
    expect(j.raw).toMatchObject({ regions: ['מרכז', 'שרון', 'השפלה'], locationApproximate: true, appliedOn: null, canApply: true });
    expect(j.location).toMatch(/תל אביב/);
  });
  it('the job page uses the same markup', () => {
    expect(parseJobPage(fx('jobnet-results.html'), '13551358')).toMatchObject({ title: 'Full Stack Developer' });
    expect(parseJobPage(fx('jobnet-results.html'), '1')).toBeNull();
  });
  it('a card of a job you already sent a CV to is marked', () => {
    const html = fx('jobnet-results.html').replace('<span style="color:#f15814;font-size:14px; font-weight:bold; display:none">שלחת קורות חיים למשרה זו בתאריך </span>', '<span style="color:#f15814;font-size:14px; font-weight:bold">שלחת קורות חיים למשרה זו בתאריך 30/10/2026</span>');
    expect(parseResults(html).jobs[0]!.raw).toMatchObject({ appliedOn: '2026-10-30' });
  });
});

describe('location: Jobnet regions → your locations (approximate)', () => {
  it('a region you accept passes, "השרון" and "שרון" are the same region', () => {
    expect(regionAccepted(['מרכז', 'שרון'], ['השרון'])).toBe('שרון');
    expect(regionAccepted(['צפון'], ['שרון', 'מרכז'])).toBeNull();
    expect(regionAccepted(['מרכז'], [])).toBeNull();
  });
  it('without a region mapping the sub-areas are matched against your locations as usual', () => {
    const prefs = PrefsSchema.parse({ locations: ['נתניה'], roleTypes: [{ id: 'fs', tier: 1, queries: ['x'], titleKeywords: ['full stack'] }] });
    const j = parseResults(fx('jobnet-results.html')).jobs[0]!;
    expect(prefilter({ ...j, regions: [] }, prefs).pass).toBe(true); // "נתניה ועמק חפר" is listed
    expect(prefilter({ ...j, location: 'צפון - חיפה', regions: [] }, prefs)).toMatchObject({ pass: false, reason: expect.stringMatching(/^location/) });
  });
});

describe('the send form', () => {
  it('logged in = the log-in prompt is hidden and your saved CVs are listed', () => {
    expect(sendFormLoginState(fx('jobnet-sendcv.html'))).toBe('logged_in');
    expect(sendFormLoginState('<p id="ucSendCV_pRegister">כבר רשום באתר? התחבר</p><select id="ucSendCV_ddlFiles"><option value="-1">בחר קובץ</option></select>')).toBe('logged_out');
  });
  it('the send request: any opt-in is detected (urlencoded and multipart), and the CV it carries is read', () => {
    expect(payloadOptIns('ucSendCV%24cbDistribute=on&x=1')).toBe(true);
    expect(payloadOptIns('a=1&ucSendCV%24rptDistFields%24ctl01%24cbDistField=on')).toBe(true);
    expect(payloadOptIns('ucSendCV%24cbAgent=on')).toBe(true);
    expect(payloadOptIns('ucSendCV%24cbSuggest=on')).toBe(true);
    expect(payloadOptIns('------b\r\nContent-Disposition: form-data; name="ucSendCV$rptRegiondist$ctl00$positionRegionsCBL"\r\n\r\non')).toBe(true);
    // the categories' and regions' hidden ids are always posted: not opt-ins
    expect(payloadOptIns('ucSendCV%24rptDistFields%24ctl01%24FieldID=7&ucSendCV%24rptRegiondist%24ctl00%24regionID=2&ucSendCV%24txtName=x')).toBe(false);
    expect(payloadFileName('------b\r\nContent-Disposition: form-data; name="ucSendCV$file_name"\r\n\r\nNoa Test - Resume.pdf\r\n------b')).toBe('Noa Test - Resume.pdf');
    expect(payloadFileName('ucSendCV%24file_name=Noa+Test+-+Resume.pdf&x=1')).toBe('Noa Test - Resume.pdf');
    expect(payloadFileName('x=1')).toBeNull();
  });
  it('the page after sending', () => {
    expect(parseSendResult('<script>showSuccess("קורות החיים נשלחו בהצלחה")</script>')).toEqual({ kind: 'submitted' });
    expect(parseSendResult('<span id="ucSendCV_generalError" class="text-danger">שגיאה בשליחה</span>')).toEqual({ kind: 'failed', message: 'Jobnet: שגיאה בשליחה' });
  });
});

describe('send patterns match only the site itself (analytics beacons that mention the page never do)', () => {
  it('Jobnet and JobMaster', async () => {
    const { SEND_PATTERN: JN } = await import('../src/sites/jobnet/apply.js');
    const { SEND_PATTERN: JM } = await import('../src/sites/jobmaster/parse.js');
    expect(JN.test('https://www.jobnet.co.il/Newstyle/InternalPages/SendCv.aspx?pid=1&l=4')).toBe(true);
    expect(JN.test('https://www.google-analytics.com/j/collect?dl=https://www.jobnet.co.il/Newstyle/InternalPages/SendCv.aspx')).toBe(false);
    expect(JM.test('https://www.jobmaster.co.il/api/korot/send-korot/sendkorot.api.asp')).toBe(true);
    expect(JM.test('https://analytics.google.com/g/collect?dl=https://www.jobmaster.co.il/api/korot/send-korot/sendkorot.api.asp')).toBe(false);
  });
});
