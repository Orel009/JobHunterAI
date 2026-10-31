/**
 * Jobnet apply flow against LOCAL copies of real pages (sanitized captures, 2026-10-31; the send form was opened
 * while logged in and never submitted). Every request is intercepted; nothing reaches the site. The form posts
 * natively (an ASP.NET postback, multipart); a small harness plays the site's CV picker ("שינוי" → saved files).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-jobnet';
  process.env.PREFERENCES_FILE = 'data/test-jobnet/preferences.yaml';
});

import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../src/config.js';
import { fillPanel, installDryRunGuard, openPanel, screenshotPanel, submitPanel } from '../src/sites/jobnet/apply.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const ID = '13551358';
const JOB = { externalId: ID, url: `https://www.jobnet.co.il/jobs?positionid=${ID}` };
const FORM_URL = `https://www.jobnet.co.il/Newstyle/InternalPages/SendCv.aspx?pid=${ID}&l=4`;

/** the site's CV picker: "שינוי" shows the saved files; choosing one fills the hidden file fields (changeFile) */
const HARNESS = `<script>
document.getElementById('deleteCookie').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('ucSendCV_afterlogin').style.display = 'block'; document.getElementById('ucSendCV_divFileSelected').style.display = 'none'; });
document.getElementById('ucSendCV_ddlFiles').addEventListener('change', (e) => {
  const o = e.target.selectedOptions[0];
  document.getElementById('ucSendCV_lblUpload').textContent = o.textContent;
  document.getElementById('ucSendCV_file_name').value = o.textContent;
  document.getElementById('ucSendCV_attach_file').value = o.value;
  document.getElementById('ucSendCV_attach_file_id').value = o.getAttribute('fileid');
  document.getElementById('ucSendCV_divFileSelected').style.display = 'block';
});
if (window.__tamper) document.getElementById('frm1').addEventListener('submit', () => { const i = document.createElement('input'); i.type = 'hidden'; i.name = 'ucSendCV$cbDistribute'; i.value = 'on'; document.getElementById('frm1').appendChild(i); });
</script>`;
/** what a visitor's form adds: the job-alert subscription (ticked by the site) and the terms box */
const VISITOR = `<input id="ucSendCV_cbAgent" type="checkbox" name="ucSendCV$cbAgent" checked="checked"><label for="ucSendCV_cbAgent">אני מעוניינ/ת לקבל הצעות עבודה למשרות דומות בחינם למייל</label>
<input id="ucSendCV_rptAgentFields_ctl00_cbAgentField" type="checkbox" name="ucSendCV$rptAgentFields$ctl00$cbAgentField" checked="checked">
<input id="ucSendCV_cbAgree" type="checkbox" name="ucSendCV$cbAgree"><label for="ucSendCV_cbAgree">אני מסכימ/ה לתנאי השימוש באתר</label>`;

let browser: Browser | undefined;
let page: Page;
let posts: string[];

async function setup(opts: { visitor?: boolean; tamper?: boolean; result?: string; loggedOut?: boolean; applied?: boolean } = {}) {
  browser ??= await chromium.launch({ headless: true });
  page = await browser.newPage();
  posts = [];
  let form = fx('jobnet-sendcv.html').replace('</body>', `${opts.tamper ? '<script>window.__tamper = true</script>' : ''}${HARNESS}</body>`);
  if (opts.visitor) form = form.replace('<div id="ucSendCV_divQuestions"', `${VISITOR}<div id="ucSendCV_divQuestions"`);
  if (opts.loggedOut) form = form.replace(/id="ucSendCV_pRegister" style="display:none;"/, 'id="ucSendCV_pRegister"');
  let results = fx('jobnet-results.html');
  if (opts.applied) results = results.replace('<span style="color:#f15814;font-size:14px; font-weight:bold; display:none">שלחת קורות חיים למשרה זו בתאריך </span>', '<span style="color:#f15814;font-size:14px; font-weight:bold">שלחת קורות חיים למשרה זו בתאריך 30/10/2026</span>');
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url === JOB.url) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: results });
    if (/SendCv\.aspx/i.test(url) && req.method() === 'GET') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: form });
    if (/SendCv\.aspx/i.test(url) && req.method() === 'POST') {
      posts.push(req.postData() ?? '');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: opts.result ?? '<html><body><script>showSuccess("קורות החיים נשלחו בהצלחה")</script></body></html>' });
    }
    return route.abort();
  });
}

const plan = (cvName = 'Noa Test - Resume.pdf', fields: ResolvedField[] = []): ApplyPlan => ({
  jobId: 'j', site: 'jobnet', createdAt: '', readiness: 'ready', notes: [], cv: { lang: 'en', cvName, hebrewRatio: 0.1, threshold: 0.2 }, fields,
});
const boxes = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('input[type=checkbox][name^="ucSendCV"]')).map((e) => [(e as HTMLInputElement).name, (e as HTMLInputElement).checked])));
const field = (body: string, name: string) => new RegExp(`name="${name.replace(/\$/g, '\\$')}"\\r?\\n\\r?\\n([^\\r\\n]*)`).exec(body)?.[1] ?? null;

fs.mkdirSync(config.paths.screenshots, { recursive: true });
beforeEach(async () => {
  await page?.close().catch(() => undefined);
});
afterAll(async () => browser?.close());

describe('jobnet apply (real send form, local copy)', () => {
  it('opens the form: your saved CVs (the attached one marked), the remarks; logged in', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    expect(state.cvs).toEqual([
      { code: 'AAAA0000000000000000000000000001.pdf', name: 'קורות חיים - נועה טסט.pdf', checked: true },
      { code: 'BBBB0000000000000000000000000002.pdf', name: 'Noa Test - Resume.pdf', checked: false },
    ]);
    expect(state.fields).toEqual([{ key: 'coverLetter', label: 'הערות (מכתב מקדים)', type: 'textarea', required: false }]);
    expect(state.extra).toEqual({ questions: [], hasAgree: false });
  });

  it('logged out → not_logged_in; already sent (the card mark) → already_applied', async () => {
    await setup({ loggedOut: true });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'not_logged_in' });
    await page.close();
    await setup({ applied: true });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'already_applied' });
  });

  it('fills: the planned CV through "שינוי", and EVERY opt-in unticked (the site ticks a distribution category)', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    expect(Object.entries(await boxes()).filter(([, v]) => v).map(([k]) => k)).toEqual(['ucSendCV$rptDistFields$ctl01$cbDistField']);
    await fillPanel(page, state, plan());
    expect(Object.values(await boxes()).some(Boolean)).toBe(false);
    expect(await page.locator('#ucSendCV_lblUpload').innerText()).toBe('Noa Test - Resume.pdf');
    expect(await page.locator('#ucSendCV_file_name').inputValue()).toBe('Noa Test - Resume.pdf');
  });

  it("a visitor's form: job alerts unticked too, and the terms box ticked only because it is required", async () => {
    await setup({ visitor: true });
    const state = await openPanel(page, JOB);
    expect(state.extra).toMatchObject({ hasAgree: true });
    expect(await boxes()).toMatchObject({ 'ucSendCV$cbAgent': true, 'ucSendCV$rptAgentFields$ctl00$cbAgentField': true, 'ucSendCV$cbAgree': false });
    await fillPanel(page, state, plan());
    const after = await boxes();
    expect(Object.entries(after).filter(([, v]) => v).map(([k]) => k)).toEqual(['ucSendCV$cbAgree']);
  });

  it('no fallback: a CV name not in the account stops the fill', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await expect(fillPanel(page, state, plan('Other.pdf'))).rejects.toMatchObject({ code: 'cv_not_found' });
  });

  it('sends: the postback carries the planned CV and NO opt-in; success is read', async () => {
    await setup({ visitor: true });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await screenshotPanel(page, 'jn-test');
    const r = await submitPanel(page, JOB, 'jn-test', 'Noa Test - Resume.pdf');
    expect(r.outcome).toEqual({ kind: 'submitted' });
    expect(posts).toHaveLength(1);
    expect(field(posts[0]!, 'ucSendCV$file_name')).toBe('Noa Test - Resume.pdf');
    expect(field(posts[0]!, 'ucSendCV$cbAgree')).toBe('on');
    for (const n of ['ucSendCV$cbDistribute', 'ucSendCV$rptDistFields$ctl01$cbDistField', 'ucSendCV$cbAgent', 'ucSendCV$rptAgentFields$ctl00$cbAgentField', 'ucSendCV$cbSuggest']) expect(field(posts[0]!, n)).toBeNull();
  });

  it('an opt-in ticked again after filling → no evidence and no send', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await page.evaluate(() => ((document.getElementById('ucSendCV_cbDistribute') as HTMLInputElement).checked = true));
    await expect(screenshotPanel(page, 'jn-test')).rejects.toMatchObject({ code: 'unsafe_form' });
    await expect(submitPanel(page, JOB, 'jn-test', 'Noa Test - Resume.pdf')).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(posts).toEqual([]);
  });

  it('the evidence must match what is drawn: a checkmark still drawn on an unticked box → no evidence, no send', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    // the site's own style (checkmark only on :checked), then a box whose state and drawing disagree
    await page.addStyleTag({ content: '.cr-icon{opacity:0} input:checked + .cr .cr-icon{opacity:1} .stale .cr-icon{opacity:1 !important}' });
    await screenshotPanel(page, 'jn-test'); // consistent: fine
    await page.evaluate(() => document.getElementById('ucSendCV_rptDistFields_cbDistField_1')!.parentElement!.classList.add('stale'));
    await expect(screenshotPanel(page, 'jn-test')).rejects.toMatchObject({ code: 'unsafe_form', message: expect.stringMatching(/cbDistField_1/) });
    await expect(submitPanel(page, JOB, 'jn-test', 'Noa Test - Resume.pdf')).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(posts).toEqual([]);
  });

  it('the postback itself is checked: an opt-in added on the way → aborted, nothing sent', async () => {
    await setup({ tamper: true });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await expect(submitPanel(page, JOB, 'jn-test', 'Noa Test - Resume.pdf')).rejects.toMatchObject({ code: 'unsafe_form', message: expect.stringMatching(/similar jobs/) });
    expect(posts).toEqual([]);
  });

  it('the postback carrying another CV than planned → aborted', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan('קורות חיים - נועה טסט.pdf'));
    await expect(submitPanel(page, JOB, 'jn-test', 'Noa Test - Resume.pdf')).rejects.toMatchObject({ code: 'unsafe_form', message: expect.stringMatching(/another CV/) });
    expect(posts).toEqual([]);
  });

  it('DRY_RUN guard: the postback is aborted', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await installDryRunGuard(page);
    await page.locator('#ucSendCV_btnSendCV').click();
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
  });
});
