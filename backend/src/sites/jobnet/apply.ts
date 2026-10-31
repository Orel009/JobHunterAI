/**
 * Jobnet apply flow (verified on the live site 2026-10-31 while logged in, never submitted):
 *   job page (clickPosition(id, l, '')) → the send form SendCv.aspx?pid={id}&l=4 (an iframe on the site; loaded
 *   directly here) — an ASP.NET form, prefilled from your account: name, phone, email, city · the attached CV
 *   (divFileSelected; "שינוי" shows the dropdown of the files saved in your account) · remarks · questions, when the
 *   job has them (radio tables rbAnswer, text txtAnswer, number numAnswer) · opt-ins:
 *     cbDistribute "send my CV to similar jobs" (+ cbDistField categories — one is ticked by the site — and
 *     positionRegionsCBL regions), cbAgent / cbAgentField job-alert subscription (shown to visitors), cbSuggest
 *     (study consulting) · cbAgree terms (visitors only) · input#ucSendCV_btnSendCV → postback → "קורות החיים נשלחו בהצלחה".
 *
 * Safety:
 *   - every opt-in (distribution, its categories and regions, job alerts, consulting) is unticked before every send;
 *     checked again before the evidence screenshot and right before the click; the postback itself is inspected and
 *     aborted if any opt-in is in it, or if it carries another CV than the planned one.
 *   - the terms box is ticked only when the form has it (it is required to send).
 *   - answers come only from the approved plan (profile / answers bank; drafts only after your review).
 *   - DRY_RUN: the postback is aborted by a route guard and the send button is never clicked.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { config } from '../../config.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import type { ApplyPlan, FormField } from '../../apply/types.js';
import { ApplyError, clean, type PanelState } from '../apply-error.js';
import { jobnetAppliedSeen } from './adapter.js';
import { jobUrl, parseJobPage, sendFormUrl } from './parse.js';

/** The send postback (the form posts back to itself). */
export const SEND_PATTERN = /^https:\/\/(www\.)?jobnet\.co\.il\/Newstyle\/InternalPages\/SendCv\.aspx/i;
/** Every opt-in box: distribution to similar jobs (+ its categories / regions), job alerts, consulting. */
export const OPT_INS = '[id*="cbDistribute"], [id*="cbDistField"], [id*="positionRegionsCBL"], [id*="cbAgent"], [id*="cbAgentField"], [id*="cbSuggest"]';
const OPT_IN_FIELD = /(^|[&\s"])ucSendCV(\$|%24)(cbDistribute|rptDistFields(\$|%24)[^=&"]*cbDistField|rptRegiondist(\$|%24)[^=&"]*positionRegionsCBL|cbAgent|rptAgentFields(\$|%24)[^=&"]*cbAgentField|cbSuggest)\b|name="ucSendCV\$(cbDistribute|rptDistFields\$[^"]*cbDistField|rptRegiondist\$[^"]*positionRegionsCBL|cbAgent|rptAgentFields\$[^"]*cbAgentField|cbSuggest)"/;

/** Is any opt-in in the posted form? (urlencoded or multipart — ASP.NET posts this form as multipart) */
export function payloadOptIns(body: string | null | undefined): boolean {
  return OPT_IN_FIELD.test(body ?? '');
}
/** The CV file name in the posted form (hidden file_name field), when present. */
export function payloadFileName(body: string | null | undefined): string | null {
  const b = body ?? '';
  const multi = /name="ucSendCV\$file_name"\r?\n\r?\n([^\r\n]*)/.exec(b)?.[1];
  if (multi !== undefined) return multi;
  const enc = /(?:^|&)ucSendCV%24file_name=([^&]*)/.exec(b)?.[1];
  return enc !== undefined ? decodeURIComponent(enc.replace(/\+/g, ' ')) : null;
}

/** Logged in: the "already registered? log in" prompt is hidden and the saved CV files are listed. */
export function sendFormLoginState(html: string): 'logged_in' | 'logged_out' | 'unknown' {
  const hidden = /id="ucSendCV_pRegister"[^>]*style="display:\s*none;?"/.test(html) || /style="display:\s*none;?"[^>]*id="ucSendCV_pRegister"/.test(html);
  const files = (/<select[^>]*id="ucSendCV_ddlFiles"[\s\S]*?<\/select>/.exec(html)?.[0].match(/<option /g) ?? []).length;
  if (hidden && files > 2) return 'logged_in';
  if (/id="ucSendCV_pRegister"/.test(html) && !hidden) return 'logged_out';
  return 'unknown';
}

export interface JnPanelExtra {
  questions: Array<{ key: string; kind: 'radio' | 'text' | 'number'; inputName: string; options: Array<{ value: string; label: string }> }>;
  hasAgree: boolean;
}

/** Opens the job's send form; reads the saved CVs and any questions. Throws ApplyError on login/form problems. */
export async function openPanel(page: Page, job: { externalId: string; url?: string }): Promise<PanelState> {
  const id = job.externalId;
  if (jobnetAppliedSeen().has(id)) throw new ApplyError('already_applied', 'Jobnet shows a CV was already sent to this job');
  // the job page first: is it still there, applied, or an external link?
  let res = await page.goto(job.url || jobUrl(id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  const j = parseJobPage(await page.content(), id);
  if (!j) throw new ApplyError('no_apply_button', 'job no longer available on Jobnet');
  const raw = j.raw as { appliedOn?: string | null; canApply?: boolean };
  if (raw.appliedOn) throw new ApplyError('already_applied', `Jobnet: a CV was sent to this job${raw.appliedOn !== 'yes' ? ` on ${raw.appliedOn}` : ''}`);
  if (j.applyType === 'external') throw new ApplyError('no_apply_button', `this job is applied to on another site: ${j.applyTarget}`);
  if (!raw.canApply) throw new ApplyError('no_apply_button', 'apply button not found on the job page');

  await pace(1500, 3500);
  res = await page.goto(sendFormUrl(id), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  const html = await page.content();
  const state = sendFormLoginState(html);
  if (state === 'logged_out') throw new ApplyError('not_logged_in', 'Jobnet session is not logged in — log in again (npm run login -- jobnet)');
  if (!(await page.locator('#ucSendCV_btnSendCV').count())) throw new ApplyError('panel_not_found', 'the Jobnet send form did not load');

  const cvs = await page.locator('#ucSendCV_ddlFiles option').evaluateAll((os) =>
    os
      .map((o) => ({ code: (o as HTMLOptionElement).value, name: (o.textContent ?? '').replace(/\s+/g, ' ').trim(), checked: false }))
      .filter((o) => o.code !== '-1' && o.code !== '0'),
  );
  const attached = clean(await page.locator('#ucSendCV_lblUpload').innerText().catch(() => ''));
  for (const c of cvs) c.checked = clean(c.name) === attached;

  // contact details come from your Jobnet account: they must be there
  const empty = await page.evaluate(() => ['ucSendCV_txtName', 'ucSendCV_txtEmail'].filter((i) => !(document.getElementById(i) as HTMLInputElement | null)?.value?.trim()));
  if (empty.length) throw new ApplyError('unexpected_form', `your Jobnet profile is missing ${empty.join(', ')} — complete it on Jobnet`);

  const questions = await page.evaluate(() => {
    const out: Array<{ key: string; label: string; kind: 'radio' | 'text' | 'number'; inputName: string; options: Array<{ value: string; label: string }> }> = [];
    const items = Array.from(document.querySelectorAll('#ucSendCV_ulQuestions > li, #ucSendCV_ulQuestions .boxes'));
    items.forEach((li, i) => {
      const radios = Array.from(li.querySelectorAll('table[id*="rbAnswer"] input[type=radio]')) as HTMLInputElement[];
      const txt = li.querySelector('[id*="txtAnswer"]') as HTMLInputElement | null;
      const num = li.querySelector('[id*="numAnswer"]') as HTMLInputElement | null;
      const label = (li.querySelector('label, h3, h4, p, span')?.textContent ?? li.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (radios.length) out.push({ key: `q.${i}`, label, kind: 'radio', inputName: radios[0]!.name, options: radios.map((r) => ({ value: r.value, label: (document.querySelector(`label[for="${r.id}"]`)?.textContent ?? r.value).trim() })) });
      else if (num) out.push({ key: `q.${i}`, label, kind: 'number', inputName: num.name, options: [] });
      else if (txt) out.push({ key: `q.${i}`, label, kind: 'text', inputName: txt.name, options: [] });
    });
    return out;
  });
  const fields: FormField[] = questions.map((q) => {
    const opts = q.options.map((o) => o.label);
    const yn = opts.length === 2 && opts.every((o) => /^(כן|לא|yes|no)$/i.test(o));
    return { key: q.key, label: q.label, type: q.kind === 'number' ? 'number' : q.kind === 'text' ? 'text' : yn ? 'yes_no' : 'choice', required: true, ...(q.kind === 'radio' && !yn ? { options: opts } : {}) };
  });
  fields.push({ key: 'coverLetter', label: 'הערות (מכתב מקדים)', type: 'textarea', required: false });
  const extra: JnPanelExtra = { questions: questions.map(({ label: _l, ...q }) => q), hasAgree: (await page.locator('[id*="cbAgree"]').count()) > 0 };
  return { fields, cvs, hasCoverLetter: true, extra };
}

/** Every opt-in unticked; throws if any stays ticked. */
export async function untickOptIns(page: Page): Promise<void> {
  const boxes = page.locator(OPT_INS);
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const b = boxes.nth(i);
    if (!(await b.isChecked().catch(() => false))) continue;
    // like a person: click the box's own label (the site's handlers and its drawing follow), then the box itself;
    // the state is never set silently, so what is drawn, what the page knows and what it posts stay the same
    const label = b.locator('xpath=ancestor::label[1]');
    if (await label.isVisible().catch(() => false)) {
      await label.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
      await label.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
    if (await b.isChecked()) await b.evaluate((el) => (el as HTMLInputElement).click());
    await page.waitForTimeout(200);
  }
  await assertNoOptIns(page);
}

/**
 * No opt-in may be ticked — checked three ways, so the evidence screenshot shows what is posted: the box's state,
 * the :checked state the page styles by, and the drawn checkmark (.cr-icon) when the site draws one.
 */
export async function assertNoOptIns(page: Page): Promise<void> {
  const ticked = await page.locator(OPT_INS).evaluateAll((els) => {
    const rows = els.map((e) => {
      const i = e as HTMLInputElement;
      const icon = i.parentElement?.querySelector('.cr-icon') as HTMLElement | null;
      const drawn = icon ? Number(getComputedStyle(icon).opacity) > 0.01 && getComputedStyle(icon).visibility !== 'hidden' : null;
      return { id: i.id, on: i.checked || i.matches(':checked'), drawn };
    });
    // the drawing counts only where the page's style tells ticked from unticked (it does on the live site)
    const styled = rows.some((r) => r.drawn === false);
    return rows.filter((r) => r.on || (styled && r.drawn === true)).map((r) => r.id);
  });
  if (ticked.length) throw new ApplyError('unsafe_form', `opt-in still ticked (${ticked.join(', ')}): "send my CV to similar jobs" / job alerts must be off — not sent`);
}

/** The CV now attached in the form (shown name and the hidden file name the form posts). */
async function attachedCv(page: Page): Promise<{ shown: string; posted: string }> {
  return page.evaluate(() => ({
    shown: (document.getElementById('ucSendCV_lblUpload')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    posted: ((document.querySelector('input[id*="file_name"]') as HTMLInputElement | null)?.value ?? '').trim(),
  }));
}

/** Fills the form from an approved plan. Never falls back to another CV, never guesses an answer. */
export async function fillPanel(page: Page, state: PanelState, plan: ApplyPlan): Promise<void> {
  if (!plan.cv) throw new ApplyError('cv_not_found', 'plan has no CV choice (set jobnet.cv.he / jobnet.cv.en in Preferences)');
  const want = clean(plan.cv.cvName);
  const cv = state.cvs.find((c) => clean(c.name) === want);
  if (!cv) throw new ApplyError('cv_not_found', `CV "${want}" not found in your Jobnet account (available: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'})`);
  const now = await attachedCv(page);
  if (clean(now.shown) !== want || (now.posted && clean(now.posted) !== want)) {
    // "שינוי" shows the dropdown of saved files; choosing one runs the site's own changeSelectedFile()
    await page.locator('#deleteCookie').click({ timeout: 5_000 }).catch(() => undefined);
    await page.locator('#ucSendCV_ddlFiles').selectOption(cv.code, { force: true }).catch(async () =>
      page.evaluate((code) => {
        const s = document.getElementById('ucSendCV_ddlFiles') as HTMLSelectElement;
        s.value = code;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, cv.code),
    );
    await page.waitForTimeout(500);
  }
  const after = await attachedCv(page);
  if (clean(after.shown) !== want || (after.posted && clean(after.posted) !== want)) throw new ApplyError('cv_not_found', `could not attach the CV "${want}" (shown: "${after.shown}")`);
  await pace(300, 700);

  await untickOptIns(page);
  const extra = (state.extra ?? {}) as Partial<JnPanelExtra>;
  if (extra.hasAgree) {
    // the terms box is required to send (visitors only); it is the only box ticked
    const agree = page.locator('[id*="cbAgree"]').first();
    if (!(await agree.isChecked())) await agree.check({ force: true }).catch(async () => agree.evaluate((el) => (el as HTMLInputElement).click()));
  }

  for (const q of extra.questions ?? []) {
    const planned = plan.fields.find((p) => p.field.key === q.key);
    if (!planned || planned.status !== 'resolved' || planned.value === null) throw new ApplyError('unexpected_form', `question not answered in the plan: "${state.fields.find((f) => f.key === q.key)?.label ?? q.key}"`);
    if (q.kind === 'radio') {
      const v = planned.value;
      const target = q.options.find((o) => clean(o.label) === clean(v) || (v === 'yes' && /^(כן|yes)$/i.test(o.label)) || (v === 'no' && /^(לא|no)$/i.test(o.label)));
      if (!target) throw new ApplyError('unexpected_form', `no option matches the planned answer "${v}"`);
      await page.locator(`input[type=radio][name="${q.inputName}"][value="${target.value}"]`).check({ force: true });
    } else await page.locator(`[name="${q.inputName}"]`).fill(planned.value);
    await pace(300, 800);
  }
  const letter = plan.fields.find((p) => p.field.key === 'coverLetter');
  if (letter?.value) await page.locator('#ucSendCV_txtRemarks').fill(letter.value);
  await assertNoOptIns(page);
}

/** Evidence of the filled form (checked again: no opt-in may be ticked when it is taken). */
export async function screenshotPanel(page: Page, name: string): Promise<string> {
  await assertNoOptIns(page);
  const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  await page.screenshot({ path: path.join(config.paths.screenshots, file), fullPage: true });
  return file;
}

/** Dry-run guard: abort the send postback for the lifetime of the page. */
export async function installDryRunGuard(page: Page): Promise<() => Promise<void>> {
  const handler = (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    log.warn({ url: route.request().url() }, 'DRY_RUN guard aborted a Jobnet send');
    return route.abort('blockedbyclient');
  };
  await page.route(SEND_PATTERN, handler);
  return () => page.unroute(SEND_PATTERN, handler);
}

export type JnSendOutcome = { kind: 'submitted' } | { kind: 'already_applied'; sentDate: string } | { kind: 'failed'; message: string; needsLogin?: boolean };
export interface JnSubmitResult {
  outcome: JnSendOutcome;
  confirmationText: string | null;
  screenshotAfter: string | null;
}

/** Reads the page after the postback. */
export function parseSendResult(html: string): JnSendOutcome {
  if (/קורות החיים נשלחו בהצלחה/.test(html)) return { kind: 'submitted' };
  if (/כבר שלחת|נשלחו בעבר/.test(html)) return { kind: 'already_applied', sentDate: 'earlier' };
  const err = [/id="ucSendCV_generalError"[^>]*>([^<]+)</, /id="ucSendCV_message"[^>]*>([^<]+)</].map((r) => r.exec(html)?.[1]?.trim()).find(Boolean);
  if (sendFormLoginState(html) === 'logged_out') return { kind: 'failed', message: 'Jobnet: not logged in', needsLogin: true };
  return { kind: 'failed', message: `Jobnet: ${err ?? 'no confirmation after sending'}` };
}

/** Real submission (only with DRY_RUN=false after approval or a passed auto-submit gate). */
export async function submitPanel(page: Page, job: { externalId: string }, shotName: string, wantCv?: string): Promise<JnSubmitResult> {
  await assertNoOptIns(page);
  let unsafe: string | null = null;
  const guard = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postData();
    if (payloadOptIns(body)) unsafe = '"send my CV to similar jobs" / job alerts was in the send request';
    const file = payloadFileName(body);
    if (!unsafe && wantCv && file !== null && clean(file) !== clean(wantCv)) unsafe = `the send request carried another CV ("${file}")`;
    if (unsafe) {
      log.error({ job: job.externalId }, `Jobnet send aborted: ${unsafe}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route(SEND_PATTERN, guard);
  try {
    const btn = page.locator('#ucSendCV_btnSendCV');
    if (!(await btn.isVisible().catch(() => false))) throw new ApplyError('unexpected_form', 'send button not found');
    const respP = page.waitForResponse((r) => SEND_PATTERN.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
    const failP = page.waitForEvent('requestfailed', { predicate: (r) => SEND_PATTERN.test(r.url()) && r.method() === 'POST', timeout: 30_000 }).catch(() => null);
    await btn.click();
    const resp = await Promise.race([respP, failP.then(() => null)]);
    if (unsafe) throw new ApplyError('unsafe_form', `${unsafe} — aborted, nothing sent`);
    if (!resp || !('text' in resp)) throw new ApplyError('site_error', 'no answer after clicking send (the form may have stopped on a validation message)');
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const html = await page.content();
    const outcome = parseSendResult(html);
    const file = `${shotName}-after-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: path.join(config.paths.screenshots, file), fullPage: false }).catch(() => undefined);
    fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-response.html`), html);
    return { outcome, confirmationText: outcome.kind === 'submitted' ? 'קורות החיים נשלחו בהצלחה' : outcome.kind === 'failed' ? outcome.message : null, screenshotAfter: file };
  } finally {
    await page.unroute(SEND_PATTERN, guard).catch(() => undefined);
  }
}

export const fetchAppliedJobs = async (_page: Page) => jobnetAppliedSeen();
