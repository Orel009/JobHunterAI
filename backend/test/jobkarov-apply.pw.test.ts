/**
 * JobKarov apply flow against a LOCAL copy of the real send form (#WinSend2, sanitized capture of the live site,
 * 2026-11-01; opened there and never sent). Every request is intercepted; nothing reaches the site. A small harness
 * plays the site's part: the account loading (window.User), the preview request, showing the form (the account's
 * "about me" prefilled, the English CV pre-selected, nothing chosen for "similar jobs"), the employer's questions and
 * the salary range, and building the send request the way the site's code does (multipart: fname … multi, cv, answers).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-jobkarov';
  process.env.PREFERENCES_FILE = 'data/test-jobkarov/preferences.yaml';
});

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../src/config.js';
import { ApplyError } from '../src/sites/apply-error.js';
import { fillPanel, installDryRunGuard, openPanel, screenshotPanel, submitPanel } from '../src/sites/jobkarov/apply.js';
import { beginBudgetSession, endBudgetSession } from '../src/core/site-budget.js';
import type { JkPreview } from '../src/sites/jobkarov/parse.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const ID = '2768407';
const JOB = { externalId: ID, url: `https://www.jobkarov.com/Search/Site/${ID}/63382` };
const FORM = fx('jobkarov-form.html');
const basePreview = JSON.parse(fx('jobkarov-preview.json')) as JkPreview;
const EN = 'Test Person - Resume';
const HE = '- טסט טסטוב';

const QUESTIONS = [
  { sfq_text: 'כמה שנות ניסיון בפיתוח תוכנה', sfq_sfqc_id: '1', sfq_option_valid_answer: '2,3,4' },
  { sfq_text: 'רמת אנגלית', sfq_sfqc_id: '2', sfq_option_valid_answer: '7,8,9,10' },
  { sfq_text: 'האם יש לך רישיון נהיגה', sfq_sfqc_id: '3', sfq_option_valid_answer: '11,12' },
];

const harness = (form: string) => `<script>
window.__FORM = ${JSON.stringify(form)};
document.addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('a.send');
  if (a && !document.querySelector('#WinSend2')) {
    e.preventDefault();
    const r = await fetch('/User/Page/?SiteID=${ID}&json=1', { method: 'POST', body: new FormData() });
    const j = await r.json();
    if (j.status === 0) return;
    document.body.insertAdjacentHTML('beforeend', window.__FORM);
    const w = document.querySelector('#WinSend2');
    w.querySelector('textarea[name="my_description"]').value = 'טקסט קיים מהחשבון';
    const cvs = w.querySelectorAll('.CVList input[name="cv"]');
    cvs[0].checked = true;
    cvs.forEach((c) => c.addEventListener('change', () => { w.querySelector('input[type="hidden"][name="cv"]').value = c.value; }));
    const groups = {};
    for (const [id, v] of Object.entries(j.optionQuestions)) (groups[v[2]] ||= []).push({ id, text: v[0] });
    if (j.questions.length) {
      const q = document.createElement('div');
      q.className = 'questions';
      q.innerHTML = 'המעסיק ביקש לדעת' + j.questions.map((x, i) => '<div><div class="quetionSection">' + x.sfq_text + '?<section>' +
        groups[x.sfq_sfqc_id].map((o) => '<div><label><input class="rb" type="radio" name="' + o.text + i + '" value="' + o.id + '">' + o.text + '</label></div>').join('') + '</section></div></div>').join('');
      w.querySelector('.left').appendChild(q);
    }
    if (j.Site.require_range) {
      const d = document.createElement('div');
      d.className = 'range';
      d.innerHTML = '<label>ציפיות שכר:</label><select name="range">' + Object.entries(j.Ranges).map(([k, t]) => '<option value="' + k + '">' + t + '</option>').join('') + '</select>';
      w.querySelector('.left').appendChild(d);
    }
    w.querySelector('button.send').addEventListener('click', async () => {
      const fd = new FormData();
      const checked = (sel) => w.querySelector(sel + ':checked')?.value ?? '';
      fd.append('fname', 'טסט'); fd.append('lname', 'טסטוב');
      fd.append('my_description', window.__forceDesc ? 'נכתב בכל זאת' : w.querySelector('textarea[name="my_description"]').value);
      fd.append('address', 'נתניה'); fd.append('SiteID', '${ID}');
      fd.append('range', w.querySelector('select[name="range"]')?.value ?? '0'); fd.append('fu1', '');
      fd.append('multi', window.__forceMultiYes ? '1' : checked('input[name="multi"]'));
      fd.append('referer', ''); fd.append('cv', checked('.CVList input[name="cv"]'));
      fd.append('answers', [...w.querySelectorAll('.quetionSection')].map((s) => s.querySelector('input:checked')?.value ?? '-1').join(',') || '-1,-1,-1');
      fd.append('phone', '0500000000');
      const res = await fetch('/User/SendCV', { method: 'POST', body: fd, headers: { Accept: 'application/json' } }).catch(() => null);
      if (!res) return;
      const body = await res.json();
      if (!res.ok && body.error === 'send captcha') {
        // the site asks for the CAPTCHA right away, carrying the whole application
        await fetch('/User/SendCvCaptcha?SiteID=${ID}&multi=' + fd.get('multi') + '&cv=' + fd.get('cv') + '&captcha=').catch(() => null);
        return;
      }
      if (body.status === 1) w.remove();
    });
  }
});
</script>`;

const jobPage = (o: { loggedIn: boolean; sent?: boolean; gone?: boolean }) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script>window.UserFromJS = true
window.User = null
setTimeout(() => { window.User = ${o.loggedIn ? '{ ID: 100001 }' : 'null'}; }, 150);</script>
<script> window.__BASE_SITES__ = ${JSON.stringify(o.gone ? [] : [{ id: Number(ID), address_id: 63382, name: 'נתניה: תומך טכני', company: 'טסט בע"מ', city_name: 'נתניה', sent: o.sent ? 1 : 0, jSent: o.sent ? { send_date: '2026-10-20T09:15:00' } : null }])};</script>
<li id="liSite${ID}"><span class="toolbar hasURL"><a class="send" href="#">הגשת מועמדות</a></span></li>
${harness(FORM)}</body></html>`;

let browser: Browser | undefined;
let page: Page;
let sent: string[];
let captchaReached: number;

async function setup(o: { loggedIn?: boolean; sent?: boolean; gone?: boolean; preview?: unknown; questions?: boolean; range?: boolean; sendStatus?: number; sendBody?: unknown } = {}) {
  browser ??= await chromium.launch({ headless: true });
  page = await browser.newPage();
  sent = [];
  captchaReached = 0;
  const prev = o.preview ?? { ...basePreview, questions: o.questions ? QUESTIONS : [], Site: { ...basePreview.Site, require_range: o.range ? 1 : 0 } };
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(JOB.url)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: jobPage({ loggedIn: o.loggedIn ?? true, sent: o.sent, gone: o.gone }) });
    if (/\/User\/Page\//.test(url)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(prev) });
    if (/\/User\/SendCV$/.test(url)) {
      sent.push(route.request().postData() ?? '');
      return route.fulfill({ status: o.sendStatus ?? 200, contentType: 'application/json', body: JSON.stringify(o.sendBody ?? { status: 1 }) });
    }
    if (/\/User\/SendCvCaptcha/.test(url)) {
      captchaReached++;
      return route.fulfill({ contentType: 'application/json', body: '{"status":1}' });
    }
    return route.abort();
  });
}

const field = (key: string, label: string, type: ResolvedField['field']['type'], value: string | null, options?: string[]): ResolvedField => ({
  field: { key, label, type, required: true, options },
  normKey: label,
  status: value === null ? 'pending' : 'resolved',
  value,
  provenance: { source: value === null ? 'none' : 'bank' },
});
const plan = (cvName = HE, fields: ResolvedField[] = []): ApplyPlan => ({
  jobId: 'x',
  site: 'jobkarov',
  createdAt: '',
  cv: { lang: 'he', cvName, hebrewRatio: 1, threshold: 0.2 },
  fields,
  readiness: 'ready',
  notes: [],
});
const answers = (exp = '2', level: string | null = 'טוב מאוד', license = 'yes', salary: string | null = '14000') => [
  field('suitability.q0', 'כמה שנות ניסיון בפיתוח תוכנה', 'number', exp),
  field('suitability.q1', 'רמת אנגלית', 'choice', level),
  field('suitability.q2', 'האם יש לך רישיון נהיגה', 'yes_no', license),
  field('salaryRange', 'ציפיות שכר (חודשי, ברוטו)', 'number', salary),
];
const fieldOf = (body: string, name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)?.[1];

beforeEach(async () => {
  fs.mkdirSync(config.paths.screenshots, { recursive: true });
  endBudgetSession('task');
  beginBudgetSession('task'); // each test is its own session (10 JobKarov page loads)
  await page?.close().catch(() => undefined);
});
afterAll(async () => {
  await browser?.close();
});

describe('JobKarov apply (local copy of the real form)', () => {
  it('opens the form: CVs by their stored file names, the questions and the salary range as plan fields', async () => {
    await setup({ questions: true, range: true });
    const s = await openPanel(page, JOB);
    expect(s.cvs).toEqual([
      { code: '5550001', name: EN, checked: true },
      { code: '5550002', name: HE, checked: false },
    ]);
    expect(s.fields.map((f) => f.key)).toEqual(['suitability.q0', 'suitability.q1', 'suitability.q2', 'salaryRange']);
    expect(s.hasCoverLetter).toBe(false);
    expect(JSON.stringify(s.extra)).not.toMatch(/0500000000|test@example/); // the account details are not kept
  });

  it('not logged in → not_logged_in, before any form', async () => {
    await setup({ loggedIn: false });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'not_logged_in' });
  });

  it('already sent ("שלחת" on the card, or "כבר שלחת" from the preview) → already_applied', async () => {
    await setup({ sent: true });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'already_applied' });
    await page.close();
    await setup({ preview: { status: 0, result: 'כבר שלחת קורות חיים למשרה זו, בתאריך 20/10/2026' } });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'already_applied' });
  });

  it("a company-site job → external_apply with the link; a job no longer listed → expired", async () => {
    await setup({ preview: { status: 0, result: 'https://careers.example.com/apply/1' } });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'external_apply', message: 'https://careers.example.com/apply/1' });
    await page.close();
    await setup({ gone: true });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'expired' });
  });

  it('fills: the planned CV, "about me" emptied, "similar jobs" = no, the answers and the closest salary range', async () => {
    await setup({ questions: true, range: true });
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE, answers()));
    const w = page.locator('#WinSend2');
    expect(await w.locator('.CVList input[value="5550002"]').isChecked()).toBe(true);
    expect(await w.locator('textarea[name="my_description"]').inputValue()).toBe('');
    expect(await w.locator('input[name="multi"][value="2"]').isChecked()).toBe(true);
    expect(await w.locator('input[name="multi"][value="1"]').isChecked()).toBe(false);
    const picked = await w.locator('.quetionSection input:checked').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(picked).toEqual(['2', '9', '11']); // 2 years → "עד שנתיים"; level from the bank; yes
    expect(await w.locator('select[name="range"]').inputValue()).toBe('7'); // 14000 → 12000-15000
  });

  it('the planned CV is missing → cv_not_found, no fallback to another file', async () => {
    await setup();
    const s = await openPanel(page, JOB);
    await expect(fillPanel(page, s, plan('קורות חיים - טסט.pdf'))).rejects.toMatchObject({ code: 'cv_not_found' });
  });

  it('an honest answer the employer does not accept → screening_mismatch (never a different answer)', async () => {
    await setup({ questions: true, range: true });
    const s = await openPanel(page, JOB);
    await expect(fillPanel(page, s, plan(HE, answers('0')))).rejects.toMatchObject({ code: 'screening_mismatch', message: expect.stringMatching(/ללא נסיון/) });
  });

  it('an unanswered question stops the fill', async () => {
    await setup({ questions: true, range: true });
    const s = await openPanel(page, JOB);
    await expect(fillPanel(page, s, plan(HE, answers('2', null)))).rejects.toMatchObject({ code: 'unexpected_form' });
  });

  it('evidence screenshot only with "similar jobs" = no', async () => {
    await setup();
    await openPanel(page, JOB);
    await expect(screenshotPanel(page, 'jk-test')).rejects.toBeInstanceOf(ApplyError); // nothing chosen yet
  });

  it('DRY_RUN: the guard aborts the send; nothing reaches the site', async () => {
    await setup();
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    await installDryRunGuard(page);
    await page.locator('#WinSend2 button.send').click();
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
  });

  it('sends: the request carries multi=2, an empty "about me" and the planned CV; it is saved with the verdict', async () => {
    await setup({ questions: true, range: true });
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE, answers()));
    const r = await submitPanel(page, JOB, 'jk-app1', HE);
    expect(r.outcome).toEqual({ kind: 'submitted' });
    expect(sent).toHaveLength(1);
    expect(fieldOf(sent[0]!, 'multi')).toBe('2');
    expect(fieldOf(sent[0]!, 'my_description')).toBe('');
    expect(fieldOf(sent[0]!, 'cv')).toBe('5550002');
    expect(fieldOf(sent[0]!, 'answers')).toBe('2,9,11');
    expect(fieldOf(sent[0]!, 'range')).toBe('7');
    const ev = fs.readFileSync(path.join(config.paths.screenshots, 'jk-app1-request.txt'), 'utf8');
    expect(ev.split('\n')[1]).toMatch(/^checked: multi=2/);
  });

  it('"similar jobs" flipped to yes in the request → aborted before it leaves, nothing sent', async () => {
    await setup();
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    await page.evaluate(() => ((window as unknown as { __forceMultiYes: boolean }).__forceMultiYes = true));
    await expect(submitPanel(page, JOB, 'jk-app2', HE)).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(sent).toEqual([]);
    expect(fs.readFileSync(path.join(config.paths.screenshots, 'jk-app2-request.txt'), 'utf8').split('\n')[1]).toMatch(/^ABORTED: "send my CV to similar jobs" is not "no"/);
  });

  it('"about me" text in the request → aborted, nothing sent', async () => {
    await setup();
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    await page.evaluate(() => ((window as unknown as { __forceDesc: boolean }).__forceDesc = true));
    await expect(submitPanel(page, JOB, 'jk-app3', HE)).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(sent).toEqual([]);
  });

  it('"similar jobs" set back to yes in the form → refused before the click', async () => {
    await setup();
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    await page.locator('#WinSend2 input[name="multi"][value="1"]').check({ force: true });
    await expect(submitPanel(page, JOB, 'jk-app4', HE)).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(sent).toEqual([]);
  });

  it('"send captcha" → needs_manual (captcha); the CAPTCHA request is aborted, never attempted', async () => {
    await setup({ sendStatus: 400, sendBody: { error: 'send captcha' } });
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    const r = await submitPanel(page, JOB, 'jk-app5', HE);
    expect(r.outcome).toMatchObject({ kind: 'needs_manual', reason: 'captcha' });
    expect(captchaReached).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(config.paths.screenshots, 'jk-app5-response.json'), 'utf8')).captchaRequestAborted).toBe(true);
  });

  it('"notActuel" → expired', async () => {
    await setup({ sendBody: { status: 0, result: 'notActuel' } });
    const s = await openPanel(page, JOB);
    await fillPanel(page, s, plan(HE));
    const r = await submitPanel(page, JOB, 'jk-app6', HE);
    expect(r.outcome).toMatchObject({ kind: 'expired' });
  });
});
