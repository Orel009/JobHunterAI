/**
 * Drushim apply flow against a LOCAL synthetic fixture only (every request is intercepted; nothing reaches the site).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { ApplyError, fillPanel, installDryRunGuard, openPanel, submitPanel } from '../src/sites/drushim/apply.js';
import type { ApplyPlan, ResolvedField } from '../src/apply/types.js';

const html = fs.readFileSync(new URL('./fixtures/drushim-apply-panel.html', import.meta.url), 'utf8');
const JOB_URL = 'https://www.drushim.co.il/job/38834331/3b284f8d/';

let browser: Browser | undefined;
let page: Page;
let sendCalls: number;

async function setup(opts: { loggedIn?: boolean; response?: unknown } = {}) {
  browser ??= await chromium.launch({ headless: true });
  page = await browser.newPage();
  sendCalls = 0;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === JOB_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (url.includes('gw.drushim.co.il/auth/seeker-details')) {
      return route.fulfill({ status: opts.loggedIn === false ? 401 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://www.drushim.co.il', 'access-control-allow-credentials': 'true' }, body: '{}' });
    }
    if (url.includes('/api/cv/sendsinglecv')) {
      sendCalls++;
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(opts.response ?? { Successful: [{ JobCode: 38834331 }], Failed: [], IsError: false }) });
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
  fields: [rf('screening.0', 'q0', 'yes'), rf('screening.1', 'q1', 'yes'), rf('consent.0', 'consent', 'yes', 'consent')],
  ...over,
});

beforeEach(async () => {
  await page?.close().catch(() => undefined);
});
afterAll(async () => browser?.close());

describe('drushim apply (local fixture)', () => {
  it('opens the panel and reads CVs, screening statements, consent and cover letter', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    expect(state.cvs.map((c) => c.name)).toEqual(['קורות חיים - דוגמה.pdf', 'Sample - Resume.pdf']);
    expect(state.fields.map((f) => [f.key, f.type])).toEqual([
      ['screening.0', 'yes_no'],
      ['screening.1', 'yes_no'],
      ['consent.0', 'consent'],
      ['coverLetter', 'textarea'],
    ]);
    expect(state.fields[0]!.label).toBe('האם יש לך ידע בתוכנת פריורטי ?');
  });

  it('DRY RUN: fills everything, and even a stray submit click never reaches send-cv', async () => {
    await setup();
    const unguard = await installDryRunGuard(page);
    const state = await openPanel(page, JOB_URL);
    await fillPanel(page, state, plan());
    expect(await page.locator('[data-nagish="apply-flow-cv-select-input"]').nth(1).isChecked()).toBe(true);
    expect(await page.locator('[data-nagish="apply-flow-submit-button"]').isEnabled()).toBe(true);
    await page.locator('[data-nagish="apply-flow-submit-button"]').click(); // simulate a bug
    await page.waitForTimeout(500);
    expect(sendCalls).toBe(0);
    await unguard();
  });

  it('real submit (approved, DRY_RUN=false): parses success and captures confirmation', async () => {
    await setup();
    const state = await openPanel(page, JOB_URL);
    await fillPanel(page, state, plan());
    const r = await submitPanel(page, 38834331, 'test-app');
    expect(sendCalls).toBe(1);
    expect(r.outcome).toEqual({ kind: 'submitted' });
    expect(r.confirmationText).toContain('נשלחו בהצלחה');
  });

  it('already applied response → already_applied', async () => {
    await setup({ response: { Successful: [], Failed: [{ JobCode: 38834331, SentDate: '2026-10-20T10:00:00' }], IsError: false } });
    const state = await openPanel(page, JOB_URL);
    await fillPanel(page, state, plan());
    const r = await submitPanel(page, 38834331, 'test-app2');
    expect(r.outcome).toEqual({ kind: 'already_applied', sentDate: '2026-10-20T10:00:00' });
  });

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
    const p = plan({ fields: [rf('screening.0', 'q0', 'yes'), rf('screening.1', 'q1', 'no'), rf('consent.0', 'c', 'yes', 'consent')] });
    await expect(fillPanel(page, state, p)).rejects.toBeInstanceOf(ApplyError);
  });

  it('not logged in → not_logged_in (we never automate login)', async () => {
    await setup({ loggedIn: false });
    await expect(openPanel(page, JOB_URL)).rejects.toMatchObject({ code: 'not_logged_in' });
  });
});
