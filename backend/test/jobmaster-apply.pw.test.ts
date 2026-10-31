/**
 * JobMaster apply flow against LOCAL copies of real pages (sanitized captures of the live site, 2026-10-31; the popup
 * was opened there and never submitted). Every request is intercepted; nothing reaches the site. A small harness
 * script plays the site's part: the preview request, showing the captured popup, and building the send request the
 * way the site's own code does (checked boxes / radios, named fields, and the multi-send flags).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-jobmaster';
  process.env.PREFERENCES_FILE = 'data/test-jobmaster/preferences.yaml';
});

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { config } from '../src/config.js';
import { ApplyError } from '../src/sites/apply-error.js';
import { fillPanel, installDryRunGuard, openPanel, screenshotPanel, submitPanel } from '../src/sites/jobmaster/apply.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const JOB = { externalId: '9907567', url: 'https://www.jobmaster.co.il/jobs/checknum.asp?key=9907567' };
const prevBase = JSON.parse(fx('jobmaster-prev.json')) as Record<string, unknown>;
/** the site's own multi-send markup (renderApplyJobPopUp), ticked as the site renders it */
const MULTI = `<div><div class="MainPanelHeader"><div><strong>שליחת קו"ח למשרות דומות</strong></div></div><div class="multiSendOptionsDiv"><ul>
${['171', '803']
  .map((n) => `<li><div class="cn-filedWrap"><input id="catMulti-${n}" name="multiSubcat" type="checkbox" value="${n}" checked /><label for="catMulti-${n}" aria-hidden="true"></label><label for="catMulti-${n}">מאשר/ת שליחת קורות חיים למשרות דומות בתחום - <strong>${n}</strong></label></div></li>`)
  .join('')}</ul></div></div>`;

const harness = (popup: string) => `<script>
window.__POPUP = ${JSON.stringify(popup)};
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[id^="applyJob"]');
  if (!b || document.querySelector('#modal_window')) return;
  const r = await fetch('/api/korot/send-korot/sendkorot-prev.api.asp', { method: 'POST', body: 'jobNum=9907567' });
  await r.json();
  document.body.insertAdjacentHTML('beforeend', window.__POPUP);
  const form = document.querySelector('form.cv-form-details');
  form.removeAttribute('onsubmit');
  document.querySelectorAll('button[name="contactDetailsStatus"]').forEach((btn) => { btn.removeAttribute('onclick'); btn.addEventListener('click', () => { window.__contact = btn.value; }); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const params = new URLSearchParams();
    for (const it of form.elements) {
      if (((it.type === 'checkbox' || it.type === 'radio') && !it.checked) || !it.name || !it.value) continue;
      params.append(it.name, it.value);
    }
    if (window.__forceMulti) params.append('multiSubcat', '171');
    if (params.has('multiSubcat')) { params.set('multiSendSes', 'y'); params.set('isCheckedMultiSend', 'y'); }
    const res = await fetch('/api/korot/send-korot/sendkorot.api.asp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() }).catch(() => null);
    if (!res) return;
    const j = await res.json();
    if (j.status === 'OK') {
      document.querySelector('#misra9907567').insertAdjacentHTML('beforeend', '<div class="cvSendSuccessfully"><span>קורות החיים נשלחו בהצלחה</span></div>');
      document.querySelector('#modal_window').remove();
    }
  });
});
</script>`;

let browser: Browser | undefined;
let page: Page;
let sent: string[];
let previews: number;

async function setup(opts: { multiSend?: boolean; contactAsked?: boolean; sendResponse?: unknown; loggedOut?: boolean } = {}) {
  browser ??= await chromium.launch({ headless: true });
  page = await browser.newPage();
  sent = [];
  previews = 0;
  let popup = fx('jobmaster-popup.html');
  if (opts.multiSend) popup = popup.replace('<div class="getMessageHTML">', `${MULTI}<div class="getMessageHTML">`);
  if (opts.contactAsked === false) popup = popup.replace(/<div class="contactDetailsStatusUpdateDate"[\s\S]*?<\/button>\s*<button[\s\S]*?<\/button>\s*<\/div>\s*<\/div>/, '');
  let jobHtml = fx('jobmaster-job.html').replace('</body>', `${harness(popup)}</body>`);
  if (opts.loggedOut) jobHtml = jobHtml.replace(/<footer>[\s\S]*?<\/footer>/, '<a aria-label="התחבר">התחבר</a>');
  const prev = { ...prevBase, multiSend: opts.multiSend ? [{ subcatnum: 171, subcatname: 'מהנדס תוכנה' }, { subcatnum: 803, subcatname: 'מתכנת' }] : [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url === JOB.url) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: jobHtml });
    if (url.endsWith('/api/korot/send-korot/sendkorot-prev.api.asp')) {
      previews++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(prev) });
    }
    if (url.endsWith('/api/korot/send-korot/sendkorot.api.asp')) {
      sent.push(req.postData() ?? '');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(opts.sendResponse ?? { status: 'OK' }) });
    }
    return route.abort();
  });
}

const rf = (key: string, label: string, value: string | null, type: ResolvedField['field']['type'] = 'yes_no'): ResolvedField => ({
  field: { key, label, type, required: true }, normKey: key, status: value ? 'resolved' : 'pending', value, provenance: { source: 'bank', ref: '1' },
});
const Q = 'suitability.1655153';
const plan = (over: Partial<ApplyPlan> = {}): ApplyPlan => ({
  jobId: 'j', site: 'jobmaster', createdAt: '', readiness: 'ready', notes: [],
  cv: { lang: 'he', cvName: 'קורות חיים - נועה טסט.pdf', hebrewRatio: 0.9, threshold: 0.2 },
  fields: [rf(Q, 'חי/ה את עולם ה-AI ומתנסה באופן יומיומי בכלים חדשים', 'yes')],
  ...over,
});
const formState = () =>
  page.evaluate(() => ({
    cv: (document.querySelector('input[name="korotVersionNum"]:checked') as HTMLInputElement | null)?.value ?? null,
    answer: (document.querySelector('select[name="slct1655153"]') as HTMLSelectElement | null)?.value ?? null,
    multiTicked: document.querySelectorAll('input[name="multiSubcat"]:checked').length,
    contact: (window as unknown as { __contact?: string }).__contact ?? null,
  }));

fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.mkdirSync(config.paths.screenshots, { recursive: true });
const writePrefs = (share: boolean) => fs.writeFileSync(config.paths.preferences, `cv: { he: a.pdf, en: b.pdf }\njobmaster:\n  cv: { he: "קורות חיים - נועה טסט.pdf", en: "Noa Test - Resume.pdf" }\n  shareContactDetails: ${share}\nroleTypes:\n  - { id: x, tier: 1, queries: [x], titleKeywords: [x] }\n`);

beforeEach(async () => {
  await page?.close().catch(() => undefined);
  writePrefs(false);
});
afterAll(async () => browser?.close());

describe('jobmaster apply (real popup, local copy)', () => {
  it('opens the popup: CVs from your account, the suitability question, contact question and multi-send', async () => {
    await setup({ multiSend: true });
    const state = await openPanel(page, JOB);
    expect(previews).toBe(1);
    expect(state.cvs.map((c) => [c.code, c.name])).toEqual([
      ['5550001', 'קורות חיים - נועה טסט.pdf'],
      ['5550002', 'Noa Test - Resume.pdf'],
    ]);
    expect(state.fields).toEqual([
      { key: Q, label: 'חי/ה את עולם ה-AI ומתנסה באופן יומיומי בכלים חדשים', type: 'yes_no', required: true },
      { key: 'coverLetter', label: 'מכתב מקדים', type: 'textarea', required: false },
    ]);
    expect(state.extra).toEqual({ qtypes: { [Q]: 'Q' }, contactAsked: true, multiSend: 2 });
  });

  it('a logged-out page → not_logged_in (nothing opened)', async () => {
    await setup({ loggedOut: true });
    await expect(openPanel(page, JOB)).rejects.toMatchObject({ code: 'not_logged_in' });
    expect(previews).toBe(0);
  });

  it('fills: the CV by name, the answer from the plan, contact = Preferences (default no), and multi-send UNTICKED', async () => {
    await setup({ multiSend: true });
    const state = await openPanel(page, JOB);
    expect((await formState()).multiTicked).toBe(2); // the site ticks them
    await fillPanel(page, state, plan());
    expect(await formState()).toEqual({ cv: '5550001', answer: '2', multiTicked: 0, contact: '0' });
  });

  it('contact sharing follows Preferences when it is set to yes; a "no" answer is a valid answer too', async () => {
    writePrefs(true);
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan({ fields: [rf(Q, 'q', 'no')] }));
    expect(await formState()).toMatchObject({ answer: '1', contact: '1' });
  });

  it('no fallback: a CV name missing from the account, or an unanswered question, stops the fill', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await expect(fillPanel(page, state, plan({ cv: { lang: 'en', cvName: 'Other.pdf', hebrewRatio: 0, threshold: 0.2 } }))).rejects.toMatchObject({ code: 'cv_not_found' });
    await expect(fillPanel(page, state, plan({ fields: [rf(Q, 'q', null)] }))).rejects.toMatchObject({ code: 'unexpected_form' });
  });

  it('sends: the request carries the CV and the answer and NO multi-send; the confirmation is read', async () => {
    await setup({ multiSend: true });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    const before = await screenshotPanel(page, 'jm-test');
    expect(fs.existsSync(path.join(config.paths.screenshots, before))).toBe(true);
    const r = await submitPanel(page, JOB, 'jm-test');
    expect(r.outcome).toEqual({ kind: 'submitted' });
    expect(r.confirmationText).toBe('קורות החיים נשלחו בהצלחה');
    expect(sent).toHaveLength(1);
    const body = new URLSearchParams(sent[0]);
    expect(body.get('korotVersionNum')).toBe('5550001');
    expect(body.get('slct1655153')).toBe('2');
    expect(body.get('jobnumber')).toBe('9907567');
    for (const k of ['multiSubcat', 'isCheckedMultiSend', 'multiSendSes']) expect(body.has(k)).toBe(false);
  });

  it('multi-send ticked again after filling → no evidence screenshot and no send', async () => {
    await setup({ multiSend: true });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await page.evaluate(() => ((document.querySelector('input[name="multiSubcat"]') as HTMLInputElement).checked = true));
    await expect(screenshotPanel(page, 'jm-test')).rejects.toMatchObject({ code: 'unsafe_form' });
    await expect(submitPanel(page, JOB, 'jm-test')).rejects.toMatchObject({ code: 'unsafe_form' });
    expect(sent).toEqual([]);
  });

  it('the send request itself is checked: multi-send in the payload → aborted before it leaves, nothing sent', async () => {
    await setup({ multiSend: true });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await page.evaluate(() => ((window as unknown as { __forceMulti: boolean }).__forceMulti = true)); // the site adds it on its own
    const e = await submitPanel(page, JOB, 'jm-test').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApplyError);
    expect(e).toMatchObject({ code: 'unsafe_form', message: expect.stringMatching(/similar categories/) });
    expect(sent).toEqual([]);
  });

  it('DRY_RUN guard: the send request is aborted', async () => {
    await setup();
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    await installDryRunGuard(page);
    await page.locator('button.buttonSubmit').click();
    await page.waitForTimeout(500);
    expect(sent).toEqual([]);
  });

  it('a site error answer → failed with the site text', async () => {
    await setup({ sendResponse: { status: 'ERROR', errText: 'missing params' } });
    const state = await openPanel(page, JOB);
    await fillPanel(page, state, plan());
    const r = await submitPanel(page, JOB, 'jm-test');
    expect(r.outcome).toEqual({ kind: 'failed', message: 'JobMaster: missing params' });
  });
});
