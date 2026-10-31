/**
 * JobMaster apply flow (verified on the live site 2026-10-31, popup opened and never submitted while investigating):
 *   job page → #applyJob{key} → the site asks sendkorot-prev.api.asp (the popup's content, sends nothing) →
 *   dialog#modal_window with form.cv-form-details:
 *     your profile details (from your JobMaster account) · "expose your contact details to recruiters?" yes/no
 *     (only while unanswered on the account) · CV radio per file in your account (value = file id; "1" = the digital
 *     profile) · suitability questions (select slct{skillID}: yes/no, years, level) · "send my CV to similar
 *     categories" (multiSubcat checkboxes, TICKED by the site) · optional cover letter · button.buttonSubmit →
 *   POST sendkorot.api.asp → {status:'OK'} and "CV sent" on the card.
 *
 * Safety:
 *   - "send to similar categories" is unticked before every send; it is checked unticked again before the evidence
 *     screenshot and right before the click, and the send request itself is inspected: if it carries multiSubcat /
 *     isCheckedMultiSend the request is aborted and the send fails (nothing is sent).
 *   - suitability answers come only from the approved plan (profile / answers bank; never the LLM); an unanswered
 *     question stops the fill.
 *   - the contact-details question is answered from Preferences (jobmaster.shareContactDetails, default no).
 *   - DRY_RUN: the send request is aborted by a route guard and the submit button is never clicked.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { config } from '../../config.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import { loadPrefs } from '../../core/prefs.js';
import type { ApplyPlan } from '../../apply/types.js';
import { ApplyError, clean, type PanelState } from '../apply-error.js';
import { fetchJobMasterApplied } from './adapter.js';
import { PREVIEW_PATTERN, SEND_PATTERN, jobUrl, loginState, optionValue, parseJobPage, parseSendResponse, payloadHasMultiSend, previewFields, type JmPreview, type JmSendOutcome } from './parse.js';

const MODAL = 'dialog#modal_window';
const FORM = 'form.cv-form-details';

export interface JmPanelExtra {
  qtypes: Record<string, string>;
  contactAsked: boolean;
  multiSend: number;
}

/** Opens the job page and the apply popup; reads CVs and questions. Throws ApplyError on login/panel problems. */
export async function openPanel(page: Page, job: { externalId: string; url?: string }): Promise<PanelState> {
  const key = job.externalId;
  const res = await page.goto(job.url || jobUrl(key), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  const html = await page.content();
  if (loginState(html) === 'logged_out') throw new ApplyError('not_logged_in', 'JobMaster session is not logged in — log in again (npm run login -- jobmaster)');
  if (!parseJobPage(html, key)) throw new ApplyError('no_apply_button', 'job no longer available on JobMaster');
  const btn = page.locator(`#applyJob${key}:visible`).first();
  if (!(await btn.isVisible().catch(() => false))) throw new ApplyError('no_apply_button', 'apply button not found on the job page');

  await pace(1500, 3500);
  const previewP = page.waitForResponse((r) => PREVIEW_PATTERN.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await btn.click({ timeout: 10_000 });
  const previewRes = await previewP;
  const preview = ((await previewRes?.json().catch(() => null)) ?? null) as JmPreview | null;
  if (!preview) {
    await assertNotBlocked(page);
    throw new ApplyError('panel_not_found', 'the apply popup did not load');
  }
  if (preview.status !== 'OK') {
    if (/login/i.test(`${preview.status} ${preview.errText ?? ''}`)) throw new ApplyError('not_logged_in', `JobMaster: ${preview.status} — log in again (npm run login -- jobmaster)`);
    throw new ApplyError('site_error', `JobMaster: ${preview.errText || preview.status}`);
  }
  const form = page.locator(`${MODAL} ${FORM}`).first();
  if (!(await form.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false))) throw new ApplyError('panel_not_found', 'apply popup did not open');
  await page.waitForTimeout(600);

  const checkedCode = await form.locator('input[name="korotVersionNum"]:checked').getAttribute('value').catch(() => null);
  const cvs = (preview.korothaimFiles ?? []).map((f) => ({ code: String(f.fileID), name: clean(f.fileName), checked: String(f.fileID) === checkedCode }));
  const fields = previewFields(preview);
  const hasCoverLetter = (await form.locator('textarea[name="letter"]').count()) > 0;
  if (hasCoverLetter) fields.push({ key: 'coverLetter', label: 'מכתב מקדים', type: 'textarea', required: false });
  const extra: JmPanelExtra = {
    qtypes: Object.fromEntries((preview.skills ?? []).map((s) => [`suitability.${s.skillID}`, s.qtype])),
    contactAsked: (await form.locator('[name="contactDetailsStatus"]').count()) > 0,
    multiSend: (preview.multiSend ?? []).length,
  };
  return { fields, cvs, hasCoverLetter, extra };
}

/** Unticks every "send my CV to similar categories" box; throws if any stays ticked. */
export async function untickMultiSend(page: Page): Promise<void> {
  const boxes = page.locator(`${MODAL} ${FORM} input[name="multiSubcat"]`);
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    if (await b.isChecked()) {
      await b.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
      await b.uncheck({ force: true, timeout: 3_000 }).catch(async () => {
        const id = await b.getAttribute('id');
        const label = id ? page.locator(`${MODAL} label[for="${id}"]`).last() : null;
        if (label && (await label.isVisible().catch(() => false))) await label.click({ timeout: 3_000 }).catch(() => undefined);
        if (await b.isChecked()) await b.evaluate((el) => (el as HTMLInputElement).click());
      });
    }
  }
  await assertMultiSendUnticked(page);
}

/** The DOM check used before the evidence screenshot and right before the click. */
export async function assertMultiSendUnticked(page: Page): Promise<void> {
  const ticked = await page.locator(`${MODAL} ${FORM} input[name="multiSubcat"]:checked`).count();
  if (ticked) throw new ApplyError('unsafe_form', `"send my CV to similar categories" is still ticked (${ticked}) — not sent`);
}

/** Fills the popup from an approved plan. Never falls back to another CV, never guesses an answer. */
export async function fillPanel(page: Page, state: PanelState, plan: ApplyPlan): Promise<void> {
  if (!plan.cv) throw new ApplyError('cv_not_found', 'plan has no CV choice (set jobmaster.cv.he / jobmaster.cv.en in Preferences)');
  const want = clean(plan.cv.cvName);
  const cv = state.cvs.find((c) => clean(c.name) === want);
  if (!cv) throw new ApplyError('cv_not_found', `CV "${want}" not found in your JobMaster account (available: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'})`);
  const form = `${MODAL} ${FORM}`;
  // the CV list scrolls inside the dialog (the radio itself is styled away): scroll, then the label, then a DOM click
  const radio = page.locator(`${form} input[name="korotVersionNum"][value="${cv.code}"]`).first();
  await radio.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
  await radio.check({ force: true, timeout: 3_000 }).catch(async () => {
    const id = await radio.getAttribute('id');
    const label = id ? page.locator(`${form} label[for="${id}"]`).first() : null;
    if (label && (await label.isVisible().catch(() => false))) await label.click({ timeout: 3_000 }).catch(() => undefined);
    if (!(await radio.isChecked())) await radio.evaluate((el) => (el as HTMLInputElement).click());
  });
  if (!(await radio.isChecked())) throw new ApplyError('cv_not_found', `could not select the CV "${want}" in the popup`);
  await pace(300, 700);

  await untickMultiSend(page);

  const extra = (state.extra ?? {}) as Partial<JmPanelExtra>;
  if (extra.contactAsked) {
    const share = loadPrefs().jobmaster.shareContactDetails;
    const btn = page.locator(`${form} button[name="contactDetailsStatus"][value="${share ? '1' : '0'}"]`).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await pace(400, 900);
    }
  }

  for (const f of state.fields) {
    const planned = plan.fields.find((p) => p.field.key === f.key);
    if (f.key.startsWith('suitability.')) {
      const id = f.key.slice('suitability.'.length);
      const qtype = extra.qtypes?.[f.key] ?? 'Q';
      if (!planned || planned.status !== 'resolved' || planned.value === null) throw new ApplyError('unexpected_form', `suitability question not answered in the plan: "${f.label}"`);
      const value = optionValue(qtype, planned.value);
      if (!value) throw new ApplyError('unexpected_form', `no option matches the planned answer "${planned.value}" for "${f.label}"`);
      await page.locator(`${form} select[name="slct${id}"]`).selectOption(value);
      await pace(300, 800);
    }
    if (f.key === 'coverLetter' && planned?.value) await page.locator(`${form} textarea[name="letter"]`).fill(planned.value);
  }
  // the site may re-render parts of the popup: make sure nothing re-ticked the similar-categories boxes
  await assertMultiSendUnticked(page);
}

/** Evidence of the filled popup (checked again: "send to similar categories" must be unticked when it is taken). */
export async function screenshotPanel(page: Page, name: string): Promise<string> {
  await assertMultiSendUnticked(page);
  const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const target = path.join(config.paths.screenshots, file);
  const ok = await page
    .locator(MODAL)
    .first()
    .screenshot({ path: target, timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) await page.screenshot({ path: target, fullPage: false });
  return file;
}

/** Dry-run guard: abort any send request for the lifetime of the page (defense in depth). */
export async function installDryRunGuard(page: Page): Promise<() => Promise<void>> {
  const handler = (route: Route) => {
    log.warn({ url: route.request().url() }, 'DRY_RUN guard aborted a JobMaster send request');
    return route.abort('blockedbyclient');
  };
  await page.route(SEND_PATTERN, handler);
  return () => page.unroute(SEND_PATTERN, handler);
}

export interface JmSubmitResult {
  outcome: JmSendOutcome;
  confirmationText: string | null;
  screenshotAfter: string | null;
}

/** Real submission (only with DRY_RUN=false after approval or a passed auto-submit gate). */
export async function submitPanel(page: Page, job: { externalId: string }, shotName: string): Promise<JmSubmitResult> {
  await assertMultiSendUnticked(page);
  // the payload check: the request is inspected before it leaves the browser
  let unsafe = false;
  const guard = async (route: Route) => {
    // evidence: the exact request, as it was about to leave (kept locally with the screenshots)
    const verdict = payloadHasMultiSend(route.request().postData()) ? 'ABORTED: multi-send in the request' : 'checked: no multi-send in the request';
    fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-request.txt`), `${route.request().method()} ${route.request().url()}\n${verdict}\n\n${route.request().postData() ?? ''}`);
    if (payloadHasMultiSend(route.request().postData())) {
      unsafe = true;
      log.error({ job: job.externalId }, 'JobMaster send carried "send to similar categories" — aborted');
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route(SEND_PATTERN, guard);
  try {
    const submit = page.locator(`${MODAL} ${FORM} button.buttonSubmit`).first();
    if (!(await submit.isVisible().catch(() => false))) throw new ApplyError('unexpected_form', 'submit button not found in the popup');
    const respP = page.waitForResponse((r) => SEND_PATTERN.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
    const failP = page.waitForEvent('requestfailed', { predicate: (r) => SEND_PATTERN.test(r.url()), timeout: 30_000 }).catch(() => null);
    await submit.click();
    const resp = await Promise.race([respP, failP.then(() => null)]);
    if (unsafe) throw new ApplyError('unsafe_form', '"send my CV to similar categories" was in the send request — aborted, nothing sent');
    if (!resp || !('json' in resp)) throw new ApplyError('site_error', 'no send response seen after clicking submit');
    const body = await resp.json().catch(() => null);
    const outcome = parseSendResponse(body);
    let confirmationText: string | null = null;
    if (outcome.kind === 'submitted') {
      const ok = page.locator(`#misra${job.externalId} .cvSendSuccessfully, .cvSendSuccessfully`).first();
      await ok.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      confirmationText = clean(await ok.innerText().catch(() => '')) || 'JobMaster: status OK';
    } else confirmationText = outcome.kind === 'failed' ? outcome.message : null;
    const file = `${shotName}-after-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: path.join(config.paths.screenshots, file), fullPage: false }).catch(() => undefined);
    fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-response.json`), JSON.stringify({ status: resp.status(), body }, null, 2));
    return { outcome, confirmationText, screenshotAfter: file };
  } finally {
    await page.unroute(SEND_PATTERN, guard).catch(() => undefined);
  }
}

export const fetchAppliedJobs = fetchJobMasterApplied;
