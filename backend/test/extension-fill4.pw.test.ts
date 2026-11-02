/**
 * JobHunter Fill on two real saved pages (sanitized), Playwright, local copies only:
 *   - Workable (GOARC's application page, no job ad on it): the optional "Cover letter" and the profile-level "Summary"
 *     get their drafts (cover note / bio) written from the fetched ad; the experience entry's own "Summary" never does;
 *     the open education / experience entries are filled without "Add": a start date with a month in the field's
 *     MM/YYYY format, a year-only date left yellow with "month missing in profile"; the YES / NO question (button-styled
 *     options over hidden radios) goes to your answers bank, and once answered the YES option is clicked; a cover letter
 *     with cover letters off, or optional drafts off, is listed with the reason;
 *   - Comeet inside a frame (inManage's job page): the frame's form address is shown as "Open form in a new tab".
 * Nothing is ever submitted.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const CORE = path.join(process.cwd(), '..', 'extension', 'fill-core.js');
const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const DATA = {
  job: null,
  contact: { fullName: 'Test Person', firstName: 'Test', lastName: 'Person', email: 'test@example.com', phone: '+972-50-000-0000', city: 'Netanya', country: 'Israel', cityAlts: ['Netanya'], countryAlts: ['Israel', 'ישראל'], linkedin: null, github: null, website: null },
  cv: { lang: 'en', file: 'Test Person - Resume.pdf' },
  salary: null,
  form: [],
  bank: [],
  lang: 'en',
  profile: { currentTitle: 'Software Developer', currentCompany: 'Acme', yearsExperience: 2 },
  experience: [{ company: 'Acme', title: 'Software Developer', start: '2025', end: null, current: true, description: 'Built an API platform.' }],
  education: [{ institution: 'ORT Hermelin College', institutionAlt: 'מכללת אורט הרמלין', degree: 'Practical Software Engineer', field: 'Software Engineering', city: 'Netanya', start: '2021-10', end: '2024-07' }],
  fillCoverLetters: true,
  draftOptionalFields: true,
  hasJobContext: true,
  jobContext: "fetched from Workable's job API",
};
type Field = { key: string; label: string; type: string; required: boolean; entry: boolean; dict: string | null; empty: boolean };
type Scan = { fields: Field[]; frames: string[]; jobText: string; title: string; company: string };
type Out = { filled: number; drafts: number; needYou: number; pending: string[]; notes: string[]; questions: Array<{ question: string; type: string; options: string[] }> };
const NOTE = 'Your ad asks for React with TypeScript and a .NET or Node backend, which is the stack I work in at Acme. Guarding frontline work with real-time data is a problem I want to work on.';
const BIO = 'I am a software developer at Acme, working in React, TypeScript and Node.js. I built an API platform used by internal teams.';

let browser: Browser | undefined;
afterAll(async () => browser?.close());

async function open(html: string, css = ''): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().url() === 'http://form.test/' ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
  await page.goto('http://form.test/');
  await page.evaluate((c) => {
    const w = window as unknown as { __submits: number; __clicked: string[] };
    w.__submits = 0;
    w.__clicked = [];
    document.addEventListener('submit', (e) => (w.__submits++, e.preventDefault()), true);
    document.addEventListener('click', (e) => {
      const t = e.target as Element;
      const b = t.closest && t.closest('button, [type=submit], a, label');
      if (b) w.__clicked.push(((b as HTMLElement).innerText || b.getAttribute('aria-label') || b.tagName).trim().slice(0, 40));
    }, true);
    if (c) document.head.insertAdjacentHTML('beforeend', `<style>${c}</style>`);
  }, css);
  await page.addScriptTag({ path: CORE });
  return page;
}
const scan = (page: Page) => page.evaluate(() => (window as unknown as { JobHunterFill: { scan: (d: Document) => Scan } }).JobHunterFill.scan(document));
const fill = (page: Page, data: unknown, overlay = false) =>
  page.evaluate(([d, o]) => (window as unknown as { JobHunterFill: { run: (doc: Document, x: unknown, opts: unknown) => Promise<Out> } }).JobHunterFill.run(document, d, o ? {} : { overlay: false }), [data, overlay] as const);
const overlayHtml = (page: Page) => page.evaluate(() => document.getElementById('jobhunter-fill-overlay')!.shadowRoot!.innerHTML);
const clicked = (page: Page) => page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked);
const submits = (page: Page) => page.evaluate(() => (window as unknown as { __submits: number }).__submits);
const WK = () => fx('form-workable-goarc.html');
const keyOf = (s: Scan, name: string, n = 0) => s.fields.filter((f) => f.key.endsWith(`:${name}`) || f.key.includes(`:${name}#`))[n]!.key;

describe('Workable (GOARC): the application page without the ad', () => {
  it('the scan: no ad on the page; "Cover letter" and the profile "Summary" are draft fields even though optional; the entries\' own fields are not', async () => {
    const page = await open(WK());
    const s = await scan(page);
    expect(s.jobText.length).toBeLessThan(200);
    expect(s).toMatchObject({ title: 'Full Stack Developer', company: 'GOARC' });
    const by = (name: string, n = 0) => s.fields.filter((f) => f.key.endsWith(`:${name}`) || f.key.includes(`:${name}#`))[n]!;
    expect(by('cover_letter')).toMatchObject({ label: 'Cover letter (Optional)', required: false, dict: 'coverLetter', entry: false });
    expect(by('summary', 1)).toMatchObject({ label: 'Summary (Optional)', required: false, dict: 'bio', entry: false }); // the profile-level summary
    expect(by('summary', 0)).toMatchObject({ dict: 'entryText', entry: true }); // the experience entry's summary
    expect(by('start_date', 0)).toMatchObject({ dict: 'entryText', entry: true }); // never "notice period"
    expect(by('school')).toMatchObject({ dict: 'entryText', entry: true });
  });

  it('drafts for the optional cover letter (a cover note) and the summary (a bio), purple; the entry summary gets the role description instead', async () => {
    const page = await open(WK());
    const s = await scan(page);
    const r = await fill(page, { ...DATA, drafts: { [keyOf(s, 'cover_letter')]: { text: NOTE, flaggedClaims: [], error: null }, [keyOf(s, 'summary', 1)]: { text: BIO, flaggedClaims: [], error: null } } });
    expect(await page.locator('#cover_letter').inputValue()).toBe(NOTE);
    expect(await page.locator('#cover_letter').getAttribute('data-jobhunter-fill')).toBe('draft');
    expect(await page.locator('textarea[data-ui="summary"]').inputValue()).toBe(BIO);
    expect(await page.locator('textarea[data-ui="summary"]').getAttribute('data-jobhunter-fill')).toBe('draft');
    expect(await page.locator('textarea[name="summary"]:not([data-ui])').inputValue()).toBe('Built an API platform.');
    expect(r.drafts).toBe(2);
    expect(await submits(page)).toBe(0);
  });

  it('cover letters off: the two fields are listed with the reason; optional drafts off: likewise', async () => {
    const page = await open(WK());
    const s = await scan(page);
    const r = await fill(page, { ...DATA, fillCoverLetters: false, drafts: {} });
    expect(r.pending.filter((p) => /cover letters are OFF/.test(p))).toHaveLength(2);
    const again = await open(WK());
    const key = keyOf(s, 'cover_letter');
    const r2 = await fill(again, { ...DATA, draftOptionalFields: false, drafts: {}, draftNotes: { [key]: 'an optional field, and "draft optional cover / bio fields" is off (JobHunter → Settings → JobHunter Fill)' } });
    expect(r2.pending).toContain('Cover letter (Optional): no cover letter draft: an optional field, and "draft optional cover / bio fields" is off (JobHunter → Settings → JobHunter Fill)');
  });

  it('the open entries are filled without "Add": the education start date as MM/YYYY from a month, the year-only experience date left with "month missing"', async () => {
    const page = await open(WK());
    const r = await fill(page, { ...DATA, drafts: {} });
    expect(await page.locator('#school').inputValue()).toBe('ORT Hermelin College');
    expect(await page.locator('#degree').inputValue()).toBe('Practical Software Engineer');
    expect(await page.locator('#field_of_study').inputValue()).toBe('Software Engineering');
    expect(await page.locator('input[name="start_date"]').first().inputValue()).toBe('10/2021');
    expect(await page.locator('input[name="end_date"]').first().inputValue()).toBe('07/2024');
    expect(await page.locator('#title').inputValue()).toBe('Software Developer');
    expect(await page.locator('#company').inputValue()).toBe('Acme');
    expect(await page.locator('input[name="start_date"]').nth(1).inputValue()).toBe('');
    expect(await page.locator('input[name="start_date"]').nth(1).getAttribute('data-jobhunter-fill')).toBe('pending');
    expect(r.pending).toContain('Start date (Optional): month missing in profile — add it in Profile (e.g. 2021-10)');
    expect((await clicked(page)).filter((t) => /add/i.test(t))).toEqual([]);
    expect(r.notes.some((n) => /^education: the open entry "ORT Hermelin College"/.test(n))).toBe(true);
  });

  it('the YES / NO question: no answer on file → yellow, and into your answers bank; answered → the YES option (a button over a hidden radio) is clicked', async () => {
    const hide = 'input[type=radio]{position:absolute;opacity:0;width:0;height:0}';
    const page = await open(WK(), hide);
    const r = await fill(page, { ...DATA, drafts: {} });
    const q = 'This remote position is based in Israel. Are you currently based in Israel, and are you either an Israeli citizen or legally authorized to work in Israel?';
    expect(r.questions).toEqual([{ question: q, type: 'yes_no', options: ['YES', 'NO'] }]);
    expect(r.pending).toContain(`${q}: no answer on file`);
    expect(r.pending.filter((p) => /^(YES|NO):/.test(p))).toEqual([]);
    expect(await page.locator('fieldset[data-ui="QA_12181247"]').getAttribute('data-jobhunter-fill')).toBe('pending');
    // answered in the bank
    const page2 = await open(WK(), hide);
    const r2 = await fill(page2, { ...DATA, drafts: {}, bank: [{ question: q, answer: 'Yes', type: 'yes_no', options: ['YES', 'NO'] }] });
    expect(await page2.locator('#PHa39qHOiUDWffDX').isChecked()).toBe(true);
    expect(await page2.locator('#vrQGyXPwxn7pU0Bc').isChecked()).toBe(false);
    expect((await clicked(page2)).some((t) => t === 'YES')).toBe(true);
    expect(r2.questions).toEqual([]);
    expect(await submits(page2)).toBe(0);
  });

  it('the overlay: the fetched job context, the Fill again button', async () => {
    const page = await open(WK());
    await fill(page, { ...DATA, drafts: {} }, true);
    const h = await overlayHtml(page);
    expect(h).toMatch(/job context: fetched from Workable's job API/);
    expect(h).toMatch(/month missing in profile/);
  });
});

describe('Comeet inside a frame (inManage)', () => {
  it('the frame\'s form address is offered as "Open form in a new tab" (its own site, which this page cannot fill)', async () => {
    const page = await open(fx('page-comeet-frame.html'));
    const s = await scan(page);
    const src = 'https://www.comeet.co/jobs/B7.006/4C.C25/apply?company-name=inmanage&company-uid=B7.006&position-uid=4C.C25&position-slug=junior-react-developer&embedded=true&version=rc-314-0&referrer=https%3A%2F%2Fwww.linkedin.com%2F&field-phone-country-selector=true';
    expect(s.frames).toEqual([src]);
    expect(s.jobText).toMatch(/Junior React Developer/);
    const r = await fill(page, { ...DATA, frames: s.frames, jobContext: 'from page' }, true);
    expect(r.filled).toBe(0);
    const h = await overlayHtml(page);
    expect(h).toMatch(/frame from www\.comeet\.co/);
    expect(h).toMatch(new RegExp(`<a href="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;')}" target="_blank" rel="noopener noreferrer">Open form in a new tab</a>`));
  });
});
