/**
 * JobHunter Fill in a real page (Playwright, local copies): the Greenhouse and Lever forms (real markup, scripts
 * removed), a Hebrew form and an Easy-Apply-like step (synthetic: those pages are never loaded). Fills your details and
 * prepared answers, leaves pending ones empty and highlighted, marks the CV field, and never submits, never clicks a
 * button, never touches the CAPTCHA, never ticks a consent.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const CORE = path.join(process.cwd(), '..', 'extension', 'fill-core.js');
const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const DATA = {
  job: { id: 'j1', title: 'Big Data Engineer', company: 'Similarweb', site: 'greenhouse', siteLabel: 'Greenhouse', status: 'scored' },
  contact: { fullName: 'Test Person', firstName: 'Test', lastName: 'Person', email: 'test@example.com', phone: '050-0000000', city: 'Tel Aviv', linkedin: 'https://linkedin.com/in/test', github: 'https://github.com/test', website: null },
  cv: { lang: 'en', file: 'Test Person - Resume.pdf', reason: '' },
  salary: { number: '14000', text: '14,000–16,000 ₪ ברוטו' },
  form: [
    { name: 'question_56780370', label: 'LinkedIn Profile', status: 'resolved', value: 'https://linkedin.com/in/test', source: 'profile' },
    { name: 'question_56780372', label: 'How did you hear about this job?', status: 'pending', value: null, source: 'needs your answer' },
  ],
  bank: [
    { question: 'האם יש לך רישיון נהיגה?', answer: 'yes', type: 'yes_no', options: null },
    { question: 'How many years of work experience do you have with Node.js?', answer: '2', type: 'number', options: null },
  ],
};

let browser: Browser | undefined;
afterAll(async () => browser?.close());

/** a page with the form; the core injected like the extension does; watches for submits and button clicks */
async function open(html: string): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().url().startsWith('http://form.test/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
  await page.goto('http://form.test/');
  await page.evaluate(() => {
    const w = window as unknown as { __submits: number; __buttonClicks: number };
    w.__submits = 0;
    w.__buttonClicks = 0;
    document.addEventListener('submit', (e) => (w.__submits++, e.preventDefault()), true);
    document.addEventListener('click', (e) => (e.target as Element).closest('button, [type=submit], a') && w.__buttonClicks++, true);
  });
  await page.addScriptTag({ path: CORE });
  return page;
}
const fill = (page: Page, data: unknown = DATA) =>
  page.evaluate((d) => (window as unknown as { JobHunterFill: { run: (doc: Document, d: unknown, o?: unknown) => Promise<unknown> } }).JobHunterFill.run(document, d, { onApplied: async () => ({ ok: true }) }), data) as Promise<{
    filled: number;
    needYou: number;
    cv: string;
    cvFields: number;
  }>;
const val = (page: Page, sel: string) => page.locator(sel).first().inputValue();
const marked = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (el.closest('[data-jobhunter-fill]') ?? el).getAttribute('data-jobhunter-fill'));
const nothingSent = async (page: Page) => expect(await page.evaluate(() => [(window as unknown as { __submits: number }).__submits, (window as unknown as { __buttonClicks: number }).__buttonClicks])).toEqual([0, 0]);

describe('Greenhouse form (real markup)', () => {
  it('your details and the prepared answers; the pending question left empty and highlighted; the CV field marked', async () => {
    const page = await open(fx('form-greenhouse.html'));
    const r = await fill(page);
    expect(await val(page, '#first_name')).toBe('Test');
    expect(await val(page, '#last_name')).toBe('Person');
    expect(await val(page, '#email')).toBe('test@example.com');
    expect(await val(page, '#phone')).toBe('050-0000000');
    expect(await val(page, '#question_56780370')).toBe('https://linkedin.com/in/test');
    expect(await val(page, '#question_56780372')).toBe('');
    expect(await marked(page, '#question_56780372')).toBe('pending');
    expect(r.cvFields).toBeGreaterThan(0);
    expect(r.cv).toBe('Test Person - Resume.pdf');
    expect(r.filled).toBeGreaterThanOrEqual(5);
    // the cover letter is never filled
    expect(await page.locator('#cover_letter_text').count() ? await val(page, '#cover_letter_text') : '').toBe('');
    await nothingSent(page);
  });

  it('never overwrites what you typed; a second click starts clean', async () => {
    const page = await open(fx('form-greenhouse.html'));
    await page.fill('#email', 'mine@example.com');
    await fill(page);
    expect(await val(page, '#email')).toBe('mine@example.com');
    await fill(page);
    expect(await page.locator('#jobhunter-fill-overlay').count()).toBe(1);
  });
});

describe('Lever form (real markup)', () => {
  it('full name, email, phone, location, LinkedIn and GitHub by their labels; the CV upload marked', async () => {
    const page = await open(fx('form-lever.html'));
    const r = await fill(page, { ...DATA, job: { ...DATA.job, site: 'lever', siteLabel: 'Lever' }, form: [] });
    expect(await val(page, 'input[name="name"]')).toBe('Test Person');
    expect(await val(page, 'input[name="email"]')).toBe('test@example.com');
    expect(await val(page, 'input[name="phone"]')).toBe('050-0000000');
    expect(await val(page, 'input[name="urls[LinkedIn]"]')).toBe('https://linkedin.com/in/test');
    expect(await val(page, 'input[name="urls[GitHub]"]')).toBe('https://github.com/test');
    expect(await val(page, 'input[name="urls[Portfolio]"]')).toBe('');
    expect(r.cvFields).toBe(1);
    await nothingSent(page);
  });
});

const HEBREW = `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8"></head><body>
<form id="f" action="/send" method="post">
  <label for="n">שם מלא *</label><input id="n" required>
  <label for="m">כתובת מייל</label><input id="m" type="email">
  <label for="t">טלפון נייד</label><input id="t" type="tel">
  <label for="c">עיר מגורים</label><input id="c">
  <label for="s">מה ציפיות השכר שלך?</label><input id="s" type="number">
  <fieldset><legend>האם יש לך רישיון נהיגה?</legend>
    <label><input type="radio" name="lic" value="1">כן</label><label><input type="radio" name="lic" value="0">לא</label></fieldset>
  <label for="exp">ניסיון בשנים ב-React</label><select id="exp" required><option value="">בחר</option><option>0-1</option><option>2-3</option></select>
  <label for="why">למה את/ה רוצה לעבוד אצלנו? *</label><textarea id="why" required></textarea>
  <label for="cl">מכתב מקדים</label><textarea id="cl"></textarea>
  <label><input type="checkbox" id="agree" required> אני מסכים/ה לתנאי השימוש</label>
  <label for="cv">קורות חיים</label><input type="file" id="cv">
  <div class="g-recaptcha"><textarea name="g-recaptcha-response" id="cap"></textarea></div>
  <button type="submit">שלח</button>
</form></body></html>`;

describe('a Hebrew form (generic label matching)', () => {
  it('details, salary by your rules, a yes/no from the bank; the rest highlighted; no consent ticked; CAPTCHA untouched', async () => {
    const page = await open(HEBREW);
    const r = await fill(page);
    expect(await val(page, '#n')).toBe('Test Person');
    expect(await val(page, '#m')).toBe('test@example.com');
    expect(await val(page, '#t')).toBe('050-0000000');
    expect(await val(page, '#c')).toBe('Tel Aviv');
    expect(await val(page, '#s')).toBe('14000');
    expect(await page.locator('input[name=lic][value="1"]').isChecked()).toBe(true);
    expect(await val(page, '#exp')).toBe('');
    expect(await marked(page, '#exp')).toBe('pending');
    expect(await val(page, '#why')).toBe('');
    expect(await marked(page, '#why')).toBe('pending');
    expect(await val(page, '#cl')).toBe('');
    expect(await page.locator('#agree').isChecked()).toBe(false);
    expect(await marked(page, '#agree')).toBe('pending');
    expect(await val(page, '#cap')).toBe('');
    expect(r.needYou).toBe(3);
    await nothingSent(page);
  });

  it('"I applied" in the overlay calls back to JobHunter (through the extension)', async () => {
    const page = await open(HEBREW);
    await page.evaluate(() => {
      const w = window as unknown as { __applied: string[]; JobHunterFill: { run: (d: Document, x: unknown, o: unknown) => Promise<unknown> } };
      w.__applied = [];
      return w.JobHunterFill.run(document, { contact: {}, bank: [], form: [], job: { id: 'j9', title: 't', company: 'c', siteLabel: 'Comeet' } }, { onApplied: async (id: string) => (w.__applied.push(id), { ok: true }) });
    });
    await page.locator('#jobhunter-fill-overlay').locator('button#applied').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __applied: string[] }).__applied)).toEqual(['j9']);
    expect(await page.locator('#jobhunter-fill-overlay').locator('#msg').innerText()).toMatch(/marked as applied/);
    await nothingSent(page);
  });
});

const EASY_APPLY = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div role="dialog" aria-label="Apply">
  <div class="fb-dash-form-element"><label for="a1">First name</label><input id="a1" required aria-required="true"></div>
  <div class="fb-dash-form-element"><label for="a2">Mobile phone number</label><input id="a2" required aria-required="true"></div>
  <div class="fb-dash-form-element"><label for="a3">Email address</label><select id="a3" required><option value="">Select an option</option><option value="test@example.com">test@example.com</option></select></div>
  <div class="fb-dash-form-element"><label for="a4">How many years of work experience do you have with Node.js?</label><input id="a4" required aria-required="true"></div>
  <fieldset><legend>Are you comfortable commuting to this job's location?</legend><label><input type="radio" name="q5" value="Yes">Yes</label><label><input type="radio" name="q5" value="No">No</label></fieldset>
  <button aria-label="Continue to next step">Next</button>
</div></body></html>`;

describe('an Easy-Apply-like step (synthetic)', () => {
  it('fills this step only; an unknown yes/no stays for you; Next is never clicked', async () => {
    const page = await open(EASY_APPLY);
    const r = await fill(page, { ...DATA, form: [] });
    expect(await val(page, '#a1')).toBe('Test');
    expect(await val(page, '#a2')).toBe('050-0000000');
    expect(await val(page, '#a3')).toBe('test@example.com');
    expect(await val(page, '#a4')).toBe('2');
    expect(await page.locator('input[name=q5]:checked').count()).toBe(0);
    expect(r.filled).toBe(4);
    await nothingSent(page);
  });
});
