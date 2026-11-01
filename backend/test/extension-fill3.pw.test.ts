/**
 * JobHunter Fill on forms it has never seen (Playwright, local synthetic copies modeled on live forms):
 *   - the scan: every field as the planner sees it (label from <label> / placeholder / name, the form's heading as
 *     nearby text, select options, required), and the job ad on the page without its navigation and footer;
 *   - a required "Bio *" gets its bio draft (purple), never "fill it yourself"; a placeholder-only "Message" under
 *     "Please send us a note on why…" gets its cover-note draft (planned); "Country" → Israel from the profile;
 *   - a draft that could not be written: the reason in the overlay;
 *   - "Fill again" fills only what is still empty (a field added after the first fill);
 *   - a form in a same-origin frame is filled; another site's frame is named in the overlay (open it yourself);
 *   - an institution list that finds nothing for the full name: the next query ("ORT Hermelin") is tried;
 *   - a form with more steps: this step only, a note to click Next yourself. Nothing is ever submitted.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const CORE = path.join(process.cwd(), '..', 'extension', 'fill-core.js');
const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const DATA = {
  job: null,
  contact: {
    fullName: 'Test Person',
    firstName: 'Test',
    lastName: 'Person',
    email: 'test@example.com',
    phone: '050-0000000',
    city: 'Netanya',
    country: 'Israel',
    cityAlts: ['Netanya', 'נתניה'],
    countryAlts: ['Israel', 'ישראל'],
    linkedin: null,
    github: null,
    website: null,
  },
  cv: { lang: 'en', file: 'Test Person - Resume.pdf' },
  salary: null,
  form: [],
  bank: [],
  lang: 'en',
  profile: { currentTitle: 'Developer', currentCompany: 'Acme', yearsExperience: 2 },
  experience: [],
  education: [],
  fillCoverLetters: true,
};
type Field = { key: string; label: string; placeholder: string; name: string; type: string; options: string[]; required: boolean; near: string; empty: boolean; dict: string | null };
type Scan = { fields: Field[]; title: string; company: string; jobText: string; frames: string[]; lang: string };
type Out = { filled: number; drafts: number; needYou: number; pending: string[]; notes: string[]; flaggedClaims: string[] };

let browser: Browser | undefined;
afterAll(async () => browser?.close());

async function open(html: string, more: Record<string, string> = {}): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u === 'http://form.test/') return r.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (more[u]) return r.fulfill({ contentType: 'text/html; charset=utf-8', body: more[u] });
    return r.abort();
  });
  await page.goto('http://form.test/');
  await page.evaluate(() => {
    const w = window as unknown as { __submits: number };
    w.__submits = 0;
    document.addEventListener('submit', (e) => (w.__submits++, e.preventDefault()), true);
  });
  await page.addScriptTag({ path: CORE });
  return page;
}
const scan = (page: Page) => page.evaluate(() => (window as unknown as { JobHunterFill: { scan: (d: Document) => Scan } }).JobHunterFill.scan(document));
const fill = (page: Page, data: unknown, overlay = false) =>
  page.evaluate(
    ([d, o]) => (window as unknown as { JobHunterFill: { run: (doc: Document, x: unknown, opts: unknown) => Promise<Out> } }).JobHunterFill.run(document, d, o ? { onFillAgain: async () => undefined } : { overlay: false }),
    [data, overlay] as const,
  );
const kindOf = (page: Page, f: Field, plan: Record<string, string>) =>
  page.evaluate(([x, p]) => (window as unknown as { JobHunterFill: { draftKindOf: (f: unknown, p: unknown) => string | null } }).JobHunterFill.draftKindOf(x, p), [f, plan] as const);
const overlayText = (page: Page) => page.evaluate(() => document.getElementById('jobhunter-fill-overlay')!.shadowRoot!.textContent ?? '');
const BIO = 'I build full-stack features with Node.js, TypeScript and React at Acme. One of them is an API platform used by internal teams.';
const NOTE = 'Your ad asks for REST APIs in Node.js and payment integrations, which is the API work I do at Acme. Moving money reliably is a problem I want to work on.';

describe('the scan: the fields as the planner sees them, and the job ad on the page', () => {
  it('a careers page with the ad and the form: the ad without navigation / footer; "Bio *" is a required bio field', async () => {
    const page = await open(fx('form-bio.html'));
    const s = await scan(page);
    expect(s).toMatchObject({ title: 'Full Stack Developer', company: 'Example Logistics', lang: 'en', frames: [] });
    expect(s.jobText).toMatch(/2\+ years of experience building web applications with Node\.js and TypeScript/);
    expect(s.jobText).not.toMatch(/Contact sales|All rights reserved|Privacy policy|Submit application/);
    const bio = s.fields.find((f) => f.name === 'bio')!;
    expect(bio).toMatchObject({ label: 'Bio *', type: 'textarea', required: true, empty: true, dict: 'bio' });
    expect(await kindOf(page, bio, {})).toBe('bio'); // the dictionary knows it: drafted even without a plan
    expect(s.fields.map((f) => f.dict)).toEqual(['firstName', 'lastName', 'email', 'phone', 'bio']);
  });

  it('placeholder-only fields: the label from the placeholder, the form heading as nearby text, the Country options', async () => {
    const page = await open(fx('form-placeholder.html'));
    const s = await scan(page);
    const msg = s.fields.find((f) => f.name === 'msg')!;
    expect(msg).toMatchObject({ label: 'Message', placeholder: 'Message', type: 'textarea', dict: null });
    expect(msg.near).toMatch(/Please send us a note on why you want to be part of our team/);
    expect(await kindOf(page, msg, {})).toBeNull();
    expect(await kindOf(page, msg, { [msg.key]: 'draft:cover' })).toBe('cover'); // the planner's mapping
    const country = s.fields.find((f) => f.name === 'country')!;
    expect(country).toMatchObject({ type: 'select-one', dict: 'country' });
    expect(country.options).toEqual(['Country', 'Germany', 'Israel', 'United Kingdom', 'United States']);
    expect(s.jobText).toMatch(/cross-border payment APIs/);
    expect(s.jobText).not.toMatch(/Products|Blog/);
  });
});

describe('drafts, the country, and the reasons', () => {
  it('"Bio *" gets its bio draft (purple), not "fill it yourself"; your details filled; nothing submitted', async () => {
    const page = await open(fx('form-bio.html'));
    const key = (await scan(page)).fields.find((f) => f.name === 'bio')!.key;
    const r = await fill(page, { ...DATA, plan: {}, drafts: { [key]: { text: BIO, flaggedClaims: [], error: null } } });
    expect(await page.locator('#bio').inputValue()).toBe(BIO);
    expect(await page.locator('#bio').getAttribute('data-jobhunter-fill')).toBe('draft');
    expect([await page.locator('#fn').inputValue(), await page.locator('#ln').inputValue(), await page.locator('#em').inputValue()]).toEqual(['Test', 'Person', 'test@example.com']);
    expect(r).toMatchObject({ filled: 4, drafts: 1, needYou: 0 });
    expect(r.pending).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __submits: number }).__submits)).toBe(0);
  });

  it('a placeholder-only "Message" gets its planned cover-note draft; Country → Israel', async () => {
    const page = await open(fx('form-placeholder.html'));
    const s = await scan(page);
    const msg = s.fields.find((f) => f.name === 'msg')!.key;
    const r = await fill(page, { ...DATA, plan: { [msg]: 'draft:cover' }, drafts: { [msg]: { text: NOTE, flaggedClaims: ['"Moving money reliably"'], error: null } } });
    expect(await page.locator('[name=msg]').inputValue()).toBe(NOTE);
    expect(await page.locator('[name=country]').inputValue()).toBe('IL');
    expect(await page.locator('[name=full_name]').inputValue()).toBe('Test Person');
    expect(await page.locator('[name=your_phone]').inputValue()).toBe('050-0000000');
    expect(r).toMatchObject({ drafts: 1, needYou: 0, flaggedClaims: ['"Moving money reliably"'] });
  });

  it('a Hebrew country list: ישראל from the same profile value', async () => {
    const page = await open(`<!DOCTYPE html><html><body><form><label for="c">מדינה</label><select id="c"><option value="">בחר/י</option><option value="1">ארצות הברית</option><option value="2">ישראל</option></select></form></body></html>`);
    await fill(page, DATA);
    expect(await page.locator('#c').inputValue()).toBe('2');
  });

  it('a draft that could not be written: yellow, with the reason in the overlay', async () => {
    const page = await open(fx('form-bio.html'));
    const key = (await scan(page)).fields.find((f) => f.name === 'bio')!.key;
    const r = await fill(page, { ...DATA, jobContext: 'from page', drafts: { [key]: { text: null, error: 'Ollama is not running (http://127.0.0.1:11434): start it, then fill again' } } }, true);
    expect(r.pending).toEqual(['Bio *: no draft: Ollama is not running (http://127.0.0.1:11434): start it, then fill again']);
    expect(await page.locator('#bio').getAttribute('data-jobhunter-fill')).toBe('pending');
    const text = await overlayText(page);
    expect(text).toMatch(/job context: from page/);
    expect(text).toMatch(/Bio \*: no draft: Ollama is not running/);
    expect(text).toMatch(/Fill again/);
  });
});

describe('complex forms', () => {
  it('"Fill again" fills only what is still empty (a field added after the first fill); your edits stay', async () => {
    const page = await open(fx('form-bio.html'));
    await fill(page, DATA);
    await page.locator('#fn').fill('Edited');
    await page.evaluate(() => document.querySelector('#apply')!.insertAdjacentHTML('afterbegin', '<div class="field"><label for="li">LinkedIn profile</label><input id="li" name="linkedin"></div>'));
    const r = await fill(page, { ...DATA, contact: { ...DATA.contact, linkedin: 'https://linkedin.com/in/test' } });
    expect(await page.locator('#li').inputValue()).toBe('https://linkedin.com/in/test');
    expect(await page.locator('#fn').inputValue()).toBe('Edited');
    expect(r.filled).toBe(1);
  });

  it('a form inside a same-origin frame is filled; another site\'s frame is named for you to open', async () => {
    const inner = '<form><label for="e">Email</label><input id="e" type="email"></form>';
    const page = await open(
      `<!DOCTYPE html><html><body><h1>Apply</h1><iframe id="same" srcdoc='${inner}' style="width:400px;height:200px"></iframe><iframe id="other" src="http://ats.other.test/apply/123" style="width:500px;height:400px"></iframe></body></html>`,
      { 'http://ats.other.test/apply/123': '<form><input name="x"></form>' },
    );
    await page.waitForTimeout(300);
    const s = await scan(page);
    expect(s.frames).toEqual(['http://ats.other.test/apply/123']);
    const r = await fill(page, { ...DATA, frames: s.frames });
    expect(await page.frameLocator('#same').locator('#e').inputValue()).toBe('test@example.com');
    expect(r.notes).toContain('part of the form is inside a frame from ats.other.test: open http://ats.other.test/apply/123 in its own tab and click JobHunter Fill there');
  });

  it('an institution list that finds nothing for the full name: "ORT Hermelin" is tried next and its suggestion picked', async () => {
    const page = await open(`<!DOCTYPE html><html><body><form>
      <section id="edu"><h3>Education</h3><div class="list"></div><button type="button" class="add">+ Add</button></section>
      <script>
        const NAMES = ['ORT Braude College', 'ORT Hermelin Academic College of Engineering'];
        document.querySelector('#edu .add').addEventListener('click', () => {
          document.querySelector('#edu .list').insertAdjacentHTML('beforeend', '<div class="entry"><label for="i">Institution</label><input id="i" role="combobox" aria-autocomplete="list"><ul role="listbox" id="li"></ul></div>');
          const i = document.getElementById('i'), li = document.getElementById('li');
          window.__queries = [];
          // a search like the live one: suggestions that contain what you typed
          i.addEventListener('input', () => { window.__queries.push(i.value); li.innerHTML = NAMES.filter((n) => i.value.length >= 2 && n.toLowerCase().includes(i.value.toLowerCase())).map((n) => '<li role="option">' + n + '</li>').join(''); });
          li.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (o) { i.value = o.textContent; i.dataset.picked = o.textContent; li.innerHTML = ''; } });
        });
      </script></form></body></html>`);
    const r = await fill(page, { ...DATA, education: [{ institution: 'ORT Hermelin College', institutionAlt: 'מכללת אורט הרמלין', degree: 'x', field: '', city: '', start: null, end: null }] });
    expect(await page.locator('#i').getAttribute('data-picked')).toBe('ORT Hermelin Academic College of Engineering');
    expect(await page.evaluate(() => (window as unknown as { __queries: string[] }).__queries)).toEqual(['ORT Hermelin College', 'מכללת אורט הרמלין', 'ORT Hermelin']);
    expect(r.needYou).toBe(0);
  }, 30_000);

  it('a form with more steps: this step only, and a note to click Next yourself (Next is never clicked)', async () => {
    const page = await open(`<!DOCTYPE html><html><body><form><label for="e">Email</label><input id="e" type="email"><button type="button" id="next" onclick="window.__next = 1">Next</button></form></body></html>`);
    const r = await fill(page, DATA);
    expect(await page.locator('#e').inputValue()).toBe('test@example.com');
    expect(r.notes.some((n) => /more steps: .*click Next yourself/.test(n))).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __next?: number }).__next)).toBeUndefined();
  });
});
