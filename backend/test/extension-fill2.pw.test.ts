/**
 * JobHunter Fill on web-component forms and beyond your contact details (Playwright, local copies only):
 *   - the SmartRecruiters "Easy apply" form (Wix / Base44; the user's saved page, scripts removed, declarative shadow
 *     roots kept): fields inside shadow roots, values set the way frameworks accept, events that reach the component
 *     hosts, the local phone number next to the +972 selector, the country search and other profiles left alone, the
 *     privacy box left for you, and the AI draft in the message to the hiring team (purple);
 *   - a city autocomplete: the suggestion is taken only when it is exactly your city;
 *   - Experience / Education entries: "Add" inside those sections only, the new entry filled from the profile, never
 *     Save / Submit; the next entry on the next click;
 *   - cover letters off → left empty.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const CORE = path.join(process.cwd(), '..', 'extension', 'fill-core.js');
const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const DATA = {
  job: null,
  contact: { fullName: 'Test Person', firstName: 'Test', lastName: 'Person', email: 'test@example.com', phone: '+972-50-000-0000', city: 'Tel Aviv', linkedin: 'https://linkedin.com/in/test', github: 'https://github.com/test', website: null },
  cv: { lang: 'en', file: 'Test Person - Resume.pdf' },
  salary: null,
  form: [],
  bank: [],
  lang: 'en',
  profile: { currentTitle: 'Developer', currentCompany: 'Acme', yearsExperience: 2 },
  experience: [
    { company: 'Acme', title: 'Developer', start: '2023-02', end: null, current: true, description: '• Built APIs' },
    { company: 'Beta Ltd', title: 'Junior Developer', start: '2021-01', end: '2022-12', current: false, description: '• Tests' },
  ],
  education: [{ institution: 'Open University', degree: 'B.Sc.', field: 'Computer Science', start: '2017-10', end: '2021-06' }],
  fillCoverLetters: true,
  draft: { text: 'I would like to join your team. I build APIs at Acme.', flaggedClaims: ['"join your team"'], usedFactIds: ['exp.acme'], error: null },
};

let browser: Browser | undefined;
afterAll(async () => browser?.close());

async function open(html: string): Promise<Page> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().url().startsWith('http://form.test/') ? r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : r.abort()));
  await page.goto('http://form.test/');
  await page.evaluate(() => {
    const w = window as unknown as { __submits: number; __clicked: string[] };
    w.__submits = 0;
    w.__clicked = [];
    document.addEventListener('submit', (e) => (w.__submits++, e.preventDefault()), true);
    document.addEventListener(
      'click',
      (e) => {
        const t = (e.composedPath()[0] as Element) ?? (e.target as Element);
        if (t && t.closest && t.closest('button, [type=submit], a')) w.__clicked.push(((t.closest('button, a') as HTMLElement).innerText || t.getAttribute('aria-label') || '').trim());
      },
      true,
    );
  });
  await page.addScriptTag({ path: CORE });
  return page;
}
type Out = { filled: number; drafts: number; needYou: number; pending: string[]; cvFields: number; notes: string[]; flaggedClaims: string[] };
const fill = (page: Page, data: unknown = DATA) => page.evaluate((d) => (window as unknown as { JobHunterFill: { run: (doc: Document, x: unknown, o: unknown) => Promise<Out> } }).JobHunterFill.run(document, d, { overlay: false }), data);
/** the value of an input inside a component's shadow root */
const inner = (page: Page, hostSel: string) => page.evaluate((s) => ((document.querySelector(s) as HTMLElement).shadowRoot!.querySelector('input, textarea') as HTMLInputElement).value, hostSel);
const clicked = (page: Page) => page.evaluate(() => (window as unknown as { __clicked: string[]; __submits: number }).__clicked);

describe('SmartRecruiters "Easy apply" (web components, shadow DOM)', () => {
  it('fills your details inside the shadow roots, the events reach the components, the phone is local', async () => {
    const page = await open(fx('form-smartrecruiters.html'));
    await page.evaluate(() => {
      const w = window as unknown as { __hostEvents: string[] };
      w.__hostEvents = [];
      for (const h of document.querySelectorAll('spl-input, spl-phone-field')) h.addEventListener('input', () => w.__hostEvents.push(h.id));
    });
    const r = await fill(page);
    expect(await inner(page, 'spl-input#first-name-input')).toBe('Test');
    expect(await inner(page, 'spl-input#last-name-input')).toBe('Person');
    expect(await inner(page, 'spl-input#email-input')).toBe('test@example.com');
    expect(await inner(page, 'spl-input#confirm-email-input')).toBe('test@example.com');
    expect(await inner(page, 'spl-input#linkedin-input')).toBe('https://linkedin.com/in/test');
    expect(await inner(page, 'spl-input#website-input')).toBe('https://github.com/test'); // no website on file: GitHub
    // the phone input sits two shadow roots deep (spl-phone-field → spl-input → input)
    const tel = await page.evaluate(() => {
      const find = (r: Document | ShadowRoot): HTMLInputElement | null => {
        const hit = r.querySelector<HTMLInputElement>('input[type=tel]');
        if (hit) return hit;
        for (const el of r.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) {
          const x = find((el as HTMLElement).shadowRoot!);
          if (x) return x;
        }
        return null;
      };
      return find(document)!.value;
    });
    expect(tel).toBe('0500000000');
    // the input events crossed the shadow boundary (frameworks listen on the host)
    const events = await page.evaluate(() => (window as unknown as { __hostEvents: string[] }).__hostEvents);
    expect(new Set(events)).toEqual(new Set(['first-name-input', 'last-name-input', 'email-input', 'confirm-email-input', 'linkedin-input', 'website-input', 'spl-form-element_5']));
    // left alone: other profiles, the country search, the privacy box (yours to decide)
    expect(await inner(page, 'spl-input#facebook-input')).toBe('');
    expect(await inner(page, 'spl-input#twitter-input')).toBe('');
    expect(await page.evaluate(() => (document.querySelector('#spl-form-element_11') as HTMLElement).shadowRoot!.querySelector<HTMLInputElement>('input')!.checked)).toBe(false);
    // the message to the hiring team: the AI draft, purple
    expect(await page.evaluate(() => (document.querySelector('#hiring-manager-message-input') as HTMLElement).shadowRoot!.querySelector('textarea')!.value)).toBe(DATA.draft.text);
    expect(await page.locator('spl-textarea#hiring-manager-message-input').getAttribute('data-jobhunter-fill')).toBe('draft');
    expect(r).toMatchObject({ filled: 7, drafts: 1, cvFields: 2, flaggedClaims: ['"join your team"'] });
    // need you: the city (no live suggestions in a saved page) and the privacy box — nothing else
    expect(r.pending).toEqual([expect.stringMatching(/yours to decide/), expect.stringMatching(/^City: no suggestion is exactly "Tel Aviv"/)]);
    expect(await clicked(page)).toEqual([]); // no Submit, no Add (the profile entries need a live form: nothing opens here)
  });

  it('without a draft (or a failed one) the message stays empty and yellow; cover letters off → left alone', async () => {
    const page = await open(fx('form-smartrecruiters.html'));
    const r = await fill(page, { ...DATA, draft: { text: null, error: 'draft cites no facts', flaggedClaims: [] } });
    expect(r.drafts).toBe(0);
    expect(r.pending.some((p) => /no draft: draft cites no facts/.test(p))).toBe(true);
    const off = await open(fx('form-smartrecruiters.html'));
    const r2 = await fill(off, { ...DATA, fillCoverLetters: false, draft: undefined });
    expect(r2.pending.some((p) => /cover letter/.test(p))).toBe(false);
    expect(await off.evaluate(() => (document.querySelector('#hiring-manager-message-input') as HTMLElement).shadowRoot!.querySelector('textarea')!.value)).toBe('');
  });
});

const CITY = (options: string[]) => `<!DOCTYPE html><html><body><form>
  <label for="c">City</label><input id="c" role="combobox" aria-autocomplete="list" aria-controls="lb" autocomplete="off">
  <ul id="lb" role="listbox"></ul>
  <script>
    const c = document.getElementById('c'), lb = document.getElementById('lb');
    c.addEventListener('input', () => { lb.innerHTML = c.value.length >= 3 ? ${JSON.stringify(options)}.map((o) => '<li role="option">' + o + '</li>').join('') : ''; });
    lb.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (o) { c.value = o.textContent; c.dataset.picked = o.textContent; lb.innerHTML = ''; } });
  </script></form></body></html>`;

describe('a city autocomplete', () => {
  it('the suggestion that is exactly your city is taken', async () => {
    const page = await open(CITY(['Tel Aviv-Yafo, Israel', 'Tel Aviv, Israel']));
    const r = await fill(page);
    expect(await page.locator('#c').getAttribute('data-picked')).toBe('Tel Aviv, Israel');
    expect(r.filled).toBe(1);
  });
  it('no exact suggestion → cleared and left yellow for you', async () => {
    const page = await open(CITY(['Tel Aviv-Yafo, Israel', 'Tel Mond, Israel']));
    const r = await fill(page);
    expect(await page.locator('#c').inputValue()).toBe('');
    expect(await page.locator('#c').getAttribute('data-jobhunter-fill')).toBe('pending');
    expect(r.needYou).toBe(1);
  });
});

const ENTRIES = `<!DOCTYPE html><html><body><form id="f">
  <section id="exp"><h3>Experience</h3><div class="list"></div><button type="button" class="add">+ Add</button></section>
  <section id="edu"><h3>Education</h3><div class="list"></div><button type="button" class="add">+ Add</button></section>
  <button type="submit">Submit application</button>
  <script>
    const forms = {
      exp: '<div class="entry"><label>Company<input name="company"></label><label>Title<input name="title"></label><label>From<input name="from" placeholder="MM/YYYY"></label><label>To<input name="to" placeholder="MM/YYYY"></label><label><input type="checkbox" name="current"> I currently work here</label><label>Description<textarea name="desc"></textarea></label><button type="button" class="save">Save</button></div>',
      edu: '<div class="entry"><label>School<input name="school"></label><label>Degree<input name="degree"></label><label>Field of study<input name="field"></label><label>From<input type="month" name="from"></label><label>To<input type="month" name="to"></label><button type="button" class="save">Save</button></div>',
    };
    for (const s of ['exp', 'edu']) document.querySelector('#' + s + ' .add').addEventListener('click', () => document.querySelector('#' + s + ' .list').insertAdjacentHTML('beforeend', forms[s]));
  </script>
</form></body></html>`;

describe('Experience / Education entries', () => {
  it('"Add" in each section once, the new entry filled from the profile; Save and Submit never clicked', async () => {
    const page = await open(ENTRIES);
    const r = await fill(page);
    expect(await clicked(page)).toEqual(['+ Add', '+ Add']);
    const exp = page.locator('#exp .entry').first();
    expect(await exp.locator('[name=company]').inputValue()).toBe('Acme');
    expect(await exp.locator('[name=title]').inputValue()).toBe('Developer');
    expect(await exp.locator('[name=from]').inputValue()).toBe('02/2023');
    expect(await exp.locator('[name=to]').inputValue()).toBe(''); // current role: no end date, the box ticked
    expect(await exp.locator('[name=current]').isChecked()).toBe(true);
    expect(await exp.locator('[name=desc]').inputValue()).toBe('• Built APIs');
    const edu = page.locator('#edu .entry').first();
    expect(await edu.locator('[name=school]').inputValue()).toBe('Open University');
    expect(await edu.locator('[name=degree]').inputValue()).toBe('B.Sc.');
    expect(await edu.locator('[name=field]').inputValue()).toBe('Computer Science');
    expect(await edu.locator('[name=from]').inputValue()).toBe('2017-10');
    expect(await edu.locator('[name=to]').inputValue()).toBe('2021-06');
    expect(r.notes).toEqual([expect.stringMatching(/^experience: added "Acme" .* click its Save, then JobHunter Fill again for the next \(1 left\)/), expect.stringMatching(/^education: added "Open University"/)]);
    expect(await page.evaluate(() => (window as unknown as { __submits: number }).__submits)).toBe(0);
  });

  it('the next click adds the next entry (the first is on the page); nothing left → no Add', async () => {
    const page = await open(ENTRIES);
    await fill(page);
    await fill(page);
    expect(await page.locator('#exp .entry').count()).toBe(2);
    expect(await page.locator('#exp .entry').nth(1).locator('[name=company]').inputValue()).toBe('Beta Ltd');
    expect(await page.locator('#exp .entry').nth(1).locator('[name=to]').inputValue()).toBe('12/2022');
    expect(await page.locator('#edu .entry').count()).toBe(1); // education: nothing more to add
    await fill(page);
    expect(await page.locator('#exp .entry').count()).toBe(2);
    expect((await clicked(page)).every((t) => t === '+ Add')).toBe(true);
  });
});
