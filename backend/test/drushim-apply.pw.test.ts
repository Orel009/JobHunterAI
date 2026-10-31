/**
 * Drushim apply flow against LOCAL copies of real pages (sanitized captures of the live site, 2026-10-31; see the
 * comments in the fixtures). Every request is intercepted; nothing reaches the site.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { ApplyError, fillPanel, installDryRunGuard, openPanel, submitPanel } from '../src/sites/drushim/apply.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const panelHtml = fx('drushim-apply-panel.html');
const appliedHtml = fx('drushim-job-applied.html');
const realSuccess = JSON.parse(fx('drushim-sendcv-success.json')) as { Successful: Array<{ JobCode: number }> };
const JOB_URL = 'https://www.drushim.co.il/job/38728539/2df7cff1/';
const APPLIED_URL = 'https://www.drushim.co.il/job/38860893/5b7ba090/';
const PROBE = 'gw.drushim.co.il/auth/seeker-details';

let browser: Browser | undefined;
let page: Page;
let sendCalls: number;

/** probes: the statuses the session probe answers, in order (the last one repeats) */
async function setup(opts: { probes?: number[]; response?: unknown; probeAgainAfterMs?: number } = {}) {
  browser ??= await chromium.launch({ headless: true });
  page = await browser.newPage();
  sendCalls = 0;
  const probes = [...(opts.probes ?? [200])];
  if (opts.probeAgainAfterMs) {
    // the live site probes again after refreshing its token
    await page.addInitScript((ms) => setTimeout(() => void fetch('https://gw.drushim.co.il/auth/seeker-details', { credentials: 'include' }), ms), opts.probeAgainAfterMs);
  }
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === JOB_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: panelHtml });
    if (url === APPLIED_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: appliedHtml });
    if (url.includes(PROBE)) {
      const status = probes.length > 1 ? probes.shift()! : probes[0]!;
      return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://www.drushim.co.il', 'access-control-allow-credentials': 'true' }, body: '{}' });
    }
    if (url.includes('/api/cv/sendsinglecv')) {
      sendCalls++;
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(opts.response ?? { ...realSuccess, Successful: [{ ...realSuccess.Successful[0], JobCode: 38728539 }] }) });
    }
    return route.abort();
  });
}

const rf = (key: string, label: string, value: string | null, type: ResolvedField['field']['type'] = 'yes_no'): ResolvedField => ({
  field: { key, label, type, required: true }, normKey: key, status: value ? 'resolved' : 'pending', value, provenance: { source: 'bank', ref: '1' },
});
const plan = (over: Partial<ApplyPlan> = {}): ApplyPlan => ({
  jobId: 'j', site: 'drushim', createdAt: '', readiness: 'ready', notes: [],
  cv: { lang: 'en', cvName: 'Sample - Resume.pdf', hebrewRatio: 0.1, threshold: 0.2 },
  fields: [rf('screening.0', 'q0', 'yes'), rf('screening.1', 'q1', 'yes'), rf('screening.2', 'q2', 'yes')],
  ...over,
});

beforeEach(async () => {
  await page?.close().catch(() => undefined);
});
afterAll(async () => browser?.close());

describe('drushim apply (real panel, local copy)', () => {
  it('opens the panel and reads the CVs (value = CV code), the screening statements and the cover letter', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    expect(state.cvs).toEqual([
      { code: '4', name: 'קורות חיים - דוגמה.pdf', checked: true },
      { code: '3', name: 'Sample - Resume.pdf', checked: false },
    ]);
    expect(state.fields.map((f) => [f.key, f.type])).toEqual([
      ['screening.0', 'yes_no'],
      ['screening.1', 'yes_no'],
      ['screening.2', 'yes_no'],
      ['coverLetter', 'textarea'],
    ]);
    expect(state.fields[0]!.label).toBe('האם יש לך 2–3 שנות ניסיון מעשי ב-Fullstack עם PHP/Laravel ו-Vue.js בסביבת Production?');
  });

  it('DRY RUN: fills everything, the submit button enables, and even a stray click never reaches send-cv', async () => {
    await setup();
    const unguard = await installDryRunGuard(page);
    const state = await openPanel(page, JOB_URL);
    expect(await page.locator('[data-nagish="apply-flow-submit-button"]').isDisabled()).toBe(true); // as on the live panel
    await fillPanel(page, state, plan());
    expect(await page.locator('[data-nagish="apply-flow-cv-select-input"]').nth(1).isChecked()).toBe(true);
    expect(await page.locator('[data-nagish="apply-flow-submit-button"]').isEnabled()).toBe(true);
    await page.locator('[data-nagish="apply-flow-submit-button"]').click(); // simulate a bug
    await page.waitForTimeout(500);
    expect(sendCalls).toBe(0);
    await unguard();
  });

  it('real submit: the live success response is parsed, and the confirmation text has no invisible characters', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    await fillPanel(page, state, plan());
    const r = await submitPanel(page, 38728539, 'test-app');
    expect(sendCalls).toBe(1);
    expect(r.outcome).toEqual({ kind: 'submitted' });
    expect(r.confirmationText).toBe('עבודה טובה! הגשת מועמדות למשרה בינתיים, מומלץ לבדוק משרות נוספות שמתאימות לך.');
  });

  it('a Failed entry with a SentDate → already_applied', async () => {
    await setup({ response: { Successful: [], Failed: [{ JobCode: 38728539, SentDate: '28/10/2026' }], IsError: false } });
    const state = await openPanel(page, JOB_URL);
    await fillPanel(page, state, plan());
    const r = await submitPanel(page, 38728539, 'test-app2');
    expect(r.outcome).toEqual({ kind: 'already_applied', sentDate: '28/10/2026' });
  });

  it('a job you already applied to (no apply button, the "הגשת" chip) → already_applied, never a timeout', async () => {
    await setup();
    await expect(openPanel(page, APPLIED_URL)).rejects.toMatchObject({ code: 'already_applied', message: expect.stringContaining('הגשת') });
  }, 30_000);

  it('chosen CV missing → cv_not_found, never another CV', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    const p = plan({ cv: { lang: 'en', cvName: 'Other.pdf', hebrewRatio: 0, threshold: 0.2 } });
    await expect(fillPanel(page, state, p)).rejects.toMatchObject({ code: 'cv_not_found' });
    expect(await page.locator('[data-nagish="apply-flow-cv-select-input"]').nth(1).isChecked()).toBe(false);
  });

  it('refuses to tick a statement that is not confirmed in the plan', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    const p = plan({ fields: [rf('screening.0', 'q0', 'yes'), rf('screening.1', 'q1', 'no'), rf('screening.2', 'q2', 'yes')] });
    await expect(fillPanel(page, state, p)).rejects.toBeInstanceOf(ApplyError);
  });

  it('a first 401 that the token refresh turns into 200 is logged in (as on the live site)', async () => {
    await setup({ probes: [401, 200], probeAgainAfterMs: 800 });
    await expect(openPanel(page, JOB_URL)).resolves.toMatchObject({ cvs: expect.any(Array) });
  });

  it('only 401s → not_logged_in (we never automate login)', async () => {
    await setup({ probes: [401] });
    await expect(openPanel(page, JOB_URL)).rejects.toMatchObject({ code: 'not_logged_in' });
  }, 30_000);
});
