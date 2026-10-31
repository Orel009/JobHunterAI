/**
 * Drushim apply flow (from the site's own frontend code; selectors are the data-nagish hooks it ships):
 *   job page → button[job-details-apply-button] → modal[apply-flow-modal]:
 *     CV list (radio per stored CV) · screening statements (checkboxes, all must be ticked) · optional consent ·
 *     optional cover letter (toggle) · submit → POST …/api/cv/sendsinglecv → success modal.
 * Safety: in dry-run the submit button is never clicked AND any sendsinglecv request is aborted by a route guard.
 * Verified against the live site on 2026-10-31 (one real submission + captured panels, see test/fixtures):
 *   CV radios (value = the CV code), screening-question checkboxes, the cover-letter toggle, the submit button
 *   (disabled until every statement is ticked), the sendsinglecv response and the success modal. An already-applied
 *   job has no apply button at all, only a "הגשת" chip. The consent checkbox has NOT been seen on a live panel yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { config } from '../../config.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import type { ApplyPlan, FormField } from '../../apply/types.js';
import { yesNo } from '../../apply/bank.js';
import { appliedJobsFromUserdata, parseSendCvResponse, type SendCvOutcome } from './apply-parse.js';
import { watchSessionProbe } from './session-probe.js';
import cfg from './selectors.json' with { type: 'json' };
import { ApplyError, clean } from '../apply-error.js';

const S = cfg.apply;
const SEND_CV = new RegExp(S.sendCvPattern);
const APPLIED_CHIP = new RegExp(S.appliedChipText);

export { ApplyError } from '../apply-error.js';

export interface PanelState {
  fields: FormField[];
  cvs: Array<{ code: string; name: string; checked: boolean }>;
  hasCoverLetter: boolean;
}

export { clean } from '../apply-error.js';

/** The "הגשת" chip in the job-details card: this account already applied (the page then has no apply button). */
async function appliedChip(page: Page): Promise<string | null> {
  const texts = await page
    .locator(`${S.jobDetailsCard} span`)
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((t) => clean(t)).find((t) => APPLIED_CHIP.test(t)) ?? null;
}

/** Opens the job page and the apply panel; reads CVs and fields. Throws ApplyError on login/panel problems. */
export async function openPanel(page: Page, jobUrl: string): Promise<PanelState> {
  const probe = watchSessionProbe(page);
  const res = await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await assertNotBlocked(page, res?.status());
  // the first probe is often a 401 that the site's token refresh fixes a moment later: wait for the settled answer
  if ((await probe.settle()) === 'logged_out') throw new ApplyError('not_logged_in', 'Drushim session is not logged in — log in again (dashboard button or npm run login -- drushim)');

  // the button is rendered after the page loads your profile; an applied job never gets one (only the "הגשת" chip)
  const applyBtn = page.locator(S.applyButton).first();
  const visible = await applyBtn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!visible) {
    const chip = await appliedChip(page);
    if (chip) throw new ApplyError('already_applied', `job page shows "${chip}" (no apply button)`);
    throw new ApplyError('no_apply_button', 'apply button not found on the job page');
  }
  const btnText = clean(await applyBtn.innerText().catch(() => ''));
  if (new RegExp(S.alreadyAppliedButtonText).test(btnText)) throw new ApplyError('already_applied', `job page says already applied ("${btnText}")`);

  await pace(1500, 3500);
  try {
    await applyBtn.click({ timeout: 10_000 });
  } catch (e) {
    // the button can disappear when the page learns this job was already applied to
    const chip = await appliedChip(page);
    if (chip) throw new ApplyError('already_applied', `job page shows "${chip}" (the apply button went away)`);
    throw new ApplyError('panel_not_found', `could not click the apply button: ${(e as Error).message.split('\n')[0]}`);
  }
  const modal = page.locator(S.modal).first();
  const appeared = await modal.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!appeared) {
    if (await page.locator(S.loginModal).first().isVisible().catch(() => false)) throw new ApplyError('not_logged_in', 'login form opened instead of the apply panel — run: npm run login -- drushim');
    await assertNotBlocked(page);
    throw new ApplyError('panel_not_found', 'apply panel did not open');
  }
  await page.waitForTimeout(800);

  const cvs = await modal.locator(S.cvItem).evaluateAll((items, sel) =>
    items.map((li) => {
      const input = li.querySelector<HTMLInputElement>(sel.cvRadio) ?? li.querySelector<HTMLInputElement>('input[type=radio]');
      const title = li.querySelector(sel.cvTitle) ?? li.querySelector('label span');
      return { code: input?.value ?? '', name: (title?.textContent ?? '').replace(/\s+/g, ' ').trim(), checked: !!input?.checked };
    }),
    { cvRadio: S.cvRadio, cvTitle: S.cvTitle },
  );

  const screening = await modal.locator(S.screeningCheckbox).evaluateAll((els) =>
    els.map((el) => {
      const root = el.closest('label') ?? el.closest('li') ?? el;
      return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
    }),
  );
  const consent = await modal.locator(S.consentCheckbox).evaluateAll((els) =>
    els.map((el) => ((el.closest('label') ?? el).textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  const hasCoverLetter = (await modal.locator(S.coverLetterToggle).count()) > 0;

  const fields: FormField[] = [
    ...screening.map((label, i) => ({ key: `screening.${i}`, label, type: 'yes_no' as const, required: true })),
    ...consent.map((label, i) => ({ key: `consent.${i}`, label: label || 'consent', type: 'consent' as const, required: true })),
    ...(hasCoverLetter ? [{ key: 'coverLetter', label: 'מכתב מקדים', type: 'textarea' as const, required: false }] : []),
  ];
  return { fields, cvs, hasCoverLetter };
}

async function check(page: Page, selector: string, index: number) {
  const el = page.locator(`${S.modal} ${selector}`).nth(index);
  const input = (await el.evaluate((n) => n.tagName === 'INPUT')) ? el : el.locator('input[type=checkbox]').first();
  if (!(await input.isChecked().catch(() => false))) {
    await input.check({ force: true }).catch(async () => el.click());
  }
}

/** Fills the panel from an approved plan. Never falls back to another CV. */
export async function fillPanel(page: Page, state: PanelState, plan: ApplyPlan): Promise<void> {
  if (!plan.cv) throw new ApplyError('cv_not_found', 'plan has no CV choice (set cv.he / cv.en in preferences.yaml)');
  const want = clean(plan.cv.cvName);
  const idx = state.cvs.findIndex((c) => clean(c.name) === want);
  if (idx < 0) throw new ApplyError('cv_not_found', `CV "${want}" not found in the panel (available: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'})`);
  const radio = page.locator(`${S.modal} ${S.cvItem}`).nth(idx).locator('input[type=radio]').first();
  await radio.check({ force: true });
  await pace(400, 900);

  for (const f of state.fields) {
    const planned = plan.fields.find((p) => p.field.key === f.key);
    if (f.type === 'yes_no' || f.type === 'consent') {
      if (!planned || planned.status !== 'resolved' || yesNo(planned.value) !== 'yes') {
        throw new ApplyError('unexpected_form', `required statement not confirmed in plan: "${f.label}"`);
      }
      const [sel, i] = f.key.startsWith('consent') ? [S.consentCheckbox, Number(f.key.split('.')[1])] : [S.screeningCheckbox, Number(f.key.split('.')[1])];
      await check(page, sel, i);
      await pace(300, 800);
    }
    // coverLetter: left empty by policy unless a reviewed value exists
    if (f.key === 'coverLetter' && planned?.value) {
      await page.locator(`${S.modal} ${S.coverLetterToggle}`).first().click();
      await page.locator(`${S.modal} ${S.coverLetterField}`).first().fill(planned.value);
    }
  }
}

export async function screenshot(page: Page, name: string): Promise<string> {
  const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  await page.screenshot({ path: path.join(config.paths.screenshots, file), fullPage: true });
  return file;
}

/**
 * Evidence of the filled panel: the panel itself (a full-page capture of the live site showed only the dimmed
 * backdrop, not the panel). Falls back to the visible viewport.
 */
export async function screenshotPanel(page: Page, name: string): Promise<string> {
  const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const target = path.join(config.paths.screenshots, file);
  const modal = page.locator(S.modal).first();
  const ok = await modal
    .screenshot({ path: target, timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) await page.screenshot({ path: target, fullPage: false });
  return file;
}

/** Dry-run guard: abort any send-cv request for the lifetime of the page (defense in depth). */
export async function installDryRunGuard(page: Page): Promise<() => Promise<void>> {
  const handler = (route: Route) => {
    log.warn({ url: route.request().url() }, 'DRY_RUN guard aborted a send-cv request');
    return route.abort('blockedbyclient');
  };
  await page.route(SEND_CV, handler);
  return () => page.unroute(SEND_CV, handler);
}

/** Job codes this account already applied to (with the sent date), as the site itself knows them. */
export async function fetchAppliedJobs(page: Page): Promise<Map<string, string | null>> {
  const r = await page.request.get(cfg.userDataUrl, { timeout: 20_000 });
  if (!r.ok()) throw new Error(`applied-jobs list unavailable (userdata ${r.status()})`);
  return appliedJobsFromUserdata(await r.json());
}

export interface SubmitResult {
  outcome: SendCvOutcome;
  confirmationText: string | null;
  screenshotAfter: string | null;
}

/** Real submission (only called with DRY_RUN=false after explicit approval). */
export async function submitPanel(page: Page, jobCode: number, shotName: string): Promise<SubmitResult> {
  const submit = page.locator(`${S.modal} ${S.submitButton}`).first();
  if (await submit.isDisabled()) {
    const err = clean(await page.locator(S.error).first().innerText().catch(() => ''));
    throw new ApplyError('unexpected_form', `submit button is disabled${err ? `: ${err}` : ''}`);
  }
  const respP = page.waitForResponse((r) => SEND_CV.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 });
  await submit.click();
  const resp = await respP.catch(() => null);
  if (!resp) throw new ApplyError('site_error', 'no send-cv response seen after clicking submit');
  const body = await resp.json().catch(() => null);
  const outcome = parseSendCvResponse(body, jobCode);
  let confirmationText: string | null = null;
  if (outcome.kind === 'submitted') {
    const ok = page.locator(S.successModal).first();
    await ok.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    confirmationText = clean(await ok.innerText().catch(() => '')) || null;
  } else {
    confirmationText = clean(await page.locator(S.error).first().innerText().catch(() => '')) || null;
  }
  const screenshotAfter = await screenshotPanel(page, `${shotName}-after`).catch(() => screenshot(page, `${shotName}-after`));
  fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-response.json`), JSON.stringify({ status: resp.status(), body }, null, 2));
  return { outcome, confirmationText, screenshotAfter };
}
