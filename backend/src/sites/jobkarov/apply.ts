/**
 * JobKarov apply flow (verified on the live site 2026-11-01 while logged in; the form was opened, never sent):
 *   job page /Search/Site/{id}/{address} → "הגשת מועמדות" (a.send) → the site asks /User/Page/?SiteID={id}&json=1
 *   (sends nothing): a company-site link, "כבר שלחת", or the form's data → dialog #WinSend2:
 *     your account details (name, phone, address; from your JobKarov account) · the CV (radio per file in your account,
 *     value = file id; the English one is pre-selected) · "קצת על עצמי" (textarea, prefilled from your account) ·
 *     "האם לשלוח קורות חיים למשרות דומות?" (multi: 1 = yes, 2 = no; nothing selected, required) · the employer's
 *     questions (radio sets: experience buckets, level, yes/no), the salary range (select, when the job asks) ·
 *   button.send → POST /User/SendCV → status 1 = sent; "send captcha" = the site wants a CAPTCHA; "notActuel" = the
 *   employer marked the job as no longer current.
 *
 * Safety:
 *   - "send my CV to similar jobs" is set to "no" before every send; checked before the evidence screenshot and right
 *     before the click, and the send request itself is inspected: multi must be 2, "קצת על עצמי" empty and the CV the
 *     planned one, or the request is aborted (nothing sent). The request is saved next to the screenshots.
 *   - a CAPTCHA is never attempted: the CAPTCHA request is aborted and the job goes to the assisted panel (by hand).
 *   - answers come only from the approved plan (years rules, answers bank, salary rules; never the LLM for levels).
 *   - DRY_RUN: every send request is aborted by a route guard and the send button is never clicked.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright';
import { config } from '../../config.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import type { ApplyPlan } from '../../apply/types.js';
import { ApplyError, clean, type PanelState } from '../apply-error.js';
import { jobkarovAppliedSeen } from './adapter.js';
import {
  ANY_SEND_PATTERN,
  SEND_PATTERN,
  baseSites,
  jobUrl,
  optionAccepted,
  optionIdFor,
  optionsOf,
  parseSendResponse,
  payloadProblems,
  previewFields,
  previewKind,
  rangeIdFor,
  sentOn,
  type JkPreview,
  type JkSendOutcome,
} from './parse.js';

const WIN = '#WinSend2';

export interface JkPanelExtra {
  /** the preview without your account details (questions, answer sets, salary ranges, CV files) */
  preview: Omit<JkPreview, 'User'>;
}

/** Logged in: the page's script loads your account (window.User with an id). */
export async function readLogin(page: Page, timeout = 12_000): Promise<'logged_in' | 'logged_out' | 'unknown'> {
  const ok = await page
    .waitForFunction(() => {
      const u = (window as unknown as { User?: { ID?: number; id?: number } | null }).User;
      return !!u && Number(u.ID ?? u.id ?? 0) > 0;
    }, undefined, { timeout })
    .then(() => true)
    .catch(() => false);
  if (ok) return 'logged_in';
  // the page loaded normally (its user bootstrap is there) and no account came: logged out
  const bootstrap = await page.evaluate(() => 'UserFromJS' in window).catch(() => false);
  return bootstrap ? 'logged_out' : 'unknown';
}

/** The site's own preview call (what clicking "הגשת מועמדות" asks first). Sends nothing. */
async function fetchPreview(page: Page, id: string): Promise<JkPreview | null> {
  const text = await page.evaluate(async (siteId) => {
    const r = await fetch(`/User/Page/?SiteID=${siteId}&json=1`, { method: 'POST', headers: { Accept: 'application/json' }, body: new FormData() });
    return r.text();
  }, id);
  try {
    return JSON.parse(text) as JkPreview;
  } catch {
    return null;
  }
}

/** Opens the job and its send form; reads the CVs and the questions. Throws ApplyError on login/form problems. */
export async function openPanel(page: Page, job: { externalId: string; url?: string; raw?: unknown }): Promise<PanelState> {
  const id = job.externalId;
  const res = await page.goto(job.url || jobUrl(id, (job.raw as { addressId?: number } | null)?.addressId), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  const login = await readLogin(page);
  if (login !== 'logged_in') throw new ApplyError('not_logged_in', 'JobKarov session is not logged in — log in again (npm run login -- jobkarov)');
  const site = baseSites(await page.content()).find((s) => String(s.id) === id);
  if (!site) throw new ApplyError('expired', 'the job is no longer on JobKarov');
  const on = sentOn(site);
  if (on !== undefined) throw new ApplyError('already_applied', `JobKarov shows "שלחת" for this job${on ? ` (${on})` : ''}`);

  await pace(1500, 3500);
  const preview = await fetchPreview(page, id);
  const kind = previewKind(preview);
  if (kind.kind === 'external') throw new ApplyError('external_apply', kind.url);
  if (kind.kind === 'already_sent') throw new ApplyError('already_applied', `JobKarov: כבר שלחת (${kind.date})`);
  if (kind.kind === 'error') {
    if (/התחבר|login/i.test(kind.message)) throw new ApplyError('not_logged_in', `JobKarov: ${kind.message}`);
    if (/notActuel|אקטואלי|לא קיימת|הוסרה/.test(kind.message)) throw new ApplyError('expired', `JobKarov: ${kind.message}`);
    throw new ApplyError('site_error', `JobKarov: ${kind.message}`);
  }
  const p = preview!;

  const btn = page.locator('a.send:visible').first();
  if (!(await btn.isVisible().catch(() => false))) throw new ApplyError('no_apply_button', '"הגשת מועמדות" not found on the job page');
  await btn.click({ timeout: 10_000 });
  const win = page.locator(WIN).first();
  if (!(await win.locator('.CVList, .split').first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false))) {
    await assertNotBlocked(page);
    throw new ApplyError('panel_not_found', 'the send form did not open');
  }
  await page.waitForTimeout(800);

  const checked = await win.locator('.CVList input[name="cv"]:checked').getAttribute('value').catch(() => null);
  const cvs = (p.cvList ?? []).filter((c) => c.visible !== false).map((c) => ({ code: String(c.id), name: clean(c.filename), checked: String(c.id) === checked }));
  const { User: _user, ...rest } = p;
  const extra: JkPanelExtra = { preview: rest };
  return { fields: previewFields(p), cvs, hasCoverLetter: false, extra };
}

/** "send my CV to similar jobs?" must be "no" (value 2) and "yes" unselected; throws otherwise. */
export async function assertMultiNo(page: Page): Promise<void> {
  const no = await page.locator(`${WIN} input[name="multi"][value="2"]`).first().isChecked().catch(() => false);
  const yes = await page.locator(`${WIN} input[name="multi"][value="1"]:checked`).count();
  if (!no || yes) throw new ApplyError('unsafe_form', `"send my CV to similar jobs" is not set to "no" (${yes ? 'yes is selected' : 'no answer'}) — not sent`);
}

/** "קצת על עצמי" must be empty (same policy as cover letters). */
export async function assertNoDescription(page: Page): Promise<void> {
  const ta = page.locator(`${WIN} textarea[name="my_description"]`);
  if (!(await ta.count())) return;
  if ((await ta.first().inputValue()).trim()) throw new ApplyError('unsafe_form', '"קצת על עצמי" is not empty — not sent');
}

async function checkRadio(page: Page, radio: ReturnType<Page['locator']>): Promise<boolean> {
  await radio.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
  await radio.check({ force: true, timeout: 3_000 }).catch(async () => {
    const label = radio.locator('xpath=ancestor::label[1]');
    if (await label.count()) await label.first().click({ timeout: 3_000 }).catch(() => undefined);
    if (!(await radio.isChecked().catch(() => false))) await radio.evaluate((el) => (el as HTMLInputElement).click()).catch(() => undefined);
  });
  return radio.isChecked().catch(() => false);
}

/** Sets "send my CV to similar jobs?" to "no", then checks it. */
export async function setMultiNo(page: Page): Promise<void> {
  const no = page.locator(`${WIN} input[name="multi"][value="2"]`).first();
  if (!(await no.count())) throw new ApplyError('unexpected_form', '"send my CV to similar jobs?" not found in the form');
  await checkRadio(page, no);
  await assertMultiNo(page);
}

/** Fills the form from an approved plan. Never falls back to another CV, never guesses an answer. */
export async function fillPanel(page: Page, state: PanelState, plan: ApplyPlan): Promise<void> {
  if (!plan.cv) throw new ApplyError('cv_not_found', 'plan has no CV choice (set jobkarov.cv.he / jobkarov.cv.en in Preferences)');
  const want = clean(plan.cv.cvName);
  const cv = state.cvs.find((c) => clean(c.name) === want);
  if (!cv) throw new ApplyError('cv_not_found', `CV "${want}" not found in your JobKarov account (stored file names: ${state.cvs.map((c) => `"${c.name}"`).join(', ') || 'none'})`);
  const radio = page.locator(`${WIN} .CVList input[name="cv"][value="${cv.code}"]`).first();
  if (!(await radio.count())) throw new ApplyError('cv_not_found', `the CV "${want}" is not listed in the form`);
  if (!(await checkRadio(page, radio))) {
    // the row itself selects the CV (the site's click handler)
    await radio.locator('xpath=..').click({ timeout: 3_000 }).catch(() => undefined);
  }
  const chosen = await page.locator(`${WIN} input[type="hidden"][name="cv"]`).first().getAttribute('value').catch(() => null);
  if (!(await radio.isChecked().catch(() => false)) || (chosen !== null && chosen !== cv.code)) throw new ApplyError('cv_not_found', `could not select the CV "${want}" in the form`);
  await pace(300, 700);

  // "קצת על עצמי": always empty (the site prefills it from your account)
  const ta = page.locator(`${WIN} textarea[name="my_description"]`).first();
  if (await ta.count()) {
    await ta.fill('');
    await ta.dispatchEvent('input').catch(() => undefined);
  }
  await assertNoDescription(page);

  await setMultiNo(page);

  const extra = (state.extra ?? {}) as Partial<JkPanelExtra>;
  const preview = extra.preview ?? {};
  for (const f of state.fields) {
    const planned = plan.fields.find((x) => x.field.key === f.key);
    if (!planned || planned.status !== 'resolved' || planned.value === null) {
      if (f.required) throw new ApplyError('unexpected_form', `not answered in the plan: "${f.label}"`);
      continue;
    }
    if (f.key === 'salaryRange') {
      const rid = rangeIdFor(Number(planned.value), preview.Ranges);
      if (!rid) throw new ApplyError('unexpected_form', `no salary range fits the planned ${planned.value}`);
      await page.locator(`${WIN} select[name="range"]`).first().selectOption(rid);
      await pace(300, 700);
      continue;
    }
    const m = /^suitability\.q(\d+)$/.exec(f.key);
    if (!m) continue;
    const i = Number(m[1]);
    const q = preview.questions?.[i];
    const oid = optionIdFor(preview, i, planned.value);
    if (!q || !oid) throw new ApplyError('unexpected_form', `no option matches the planned answer "${planned.value}" for "${f.label}"`);
    if (!optionAccepted(q, oid)) {
      const accepted = optionsOf(preview, String(q.sfq_sfqc_id)).filter((o) => optionAccepted(q, o.id)).map((o) => o.text);
      const mine = optionsOf(preview, String(q.sfq_sfqc_id)).find((o) => o.id === oid)?.text ?? planned.value;
      throw new ApplyError('screening_mismatch', `"${f.label}": the employer accepts only ${accepted.map((t) => `"${t}"`).join(' / ')}; your answer is "${mine}"`);
    }
    const r = page.locator(`${WIN} .questions .quetionSection`).nth(i).locator(`input[type="radio"][value="${oid}"]`).first();
    if (!(await r.count()) || !(await checkRadio(page, r))) throw new ApplyError('unexpected_form', `could not select the answer for "${f.label}"`);
    await pace(300, 800);
  }
  // the form may re-render: check the opt-out and the empty description again
  await assertMultiNo(page);
  await assertNoDescription(page);
}

/** Evidence of the filled form ("similar jobs" must be "no" when it is taken). */
export async function screenshotPanel(page: Page, name: string): Promise<string> {
  await assertMultiNo(page);
  await assertNoDescription(page);
  const file = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  const target = path.join(config.paths.screenshots, file);
  const ok = await page
    .locator(WIN)
    .first()
    .screenshot({ path: target, timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) await page.screenshot({ path: target, fullPage: false });
  return file;
}

/** Dry-run guard: abort every send request (the send, its CAPTCHA variant, "add to my sent jobs"). */
export async function installDryRunGuard(page: Page): Promise<() => Promise<void>> {
  const handler = (route: Route) => {
    log.warn({ url: route.request().url() }, 'DRY_RUN guard aborted a JobKarov send request');
    return route.abort('blockedbyclient');
  };
  await page.route(ANY_SEND_PATTERN, handler);
  return () => page.unroute(ANY_SEND_PATTERN, handler);
}

export interface JkSubmitResult {
  outcome: JkSendOutcome;
  confirmationText: string | null;
  screenshotAfter: string | null;
}

/** Real submission (only with DRY_RUN=false after approval or a passed auto-submit gate). */
export async function submitPanel(page: Page, job: { externalId: string }, shotName: string, cvName?: string): Promise<JkSubmitResult> {
  await assertMultiNo(page);
  await assertNoDescription(page);
  // the planned CV, as selected in the form (the request must carry the same file id)
  const sel = page.locator(`${WIN} .CVList input[name="cv"]:checked`).first();
  const cvId = await sel.getAttribute('value').catch(() => null);
  const shown = clean(await sel.locator('xpath=..').locator('span').first().innerText().catch(() => ''));
  if (!cvId || (cvName && shown !== clean(cvName))) throw new ApplyError('unsafe_form', `the selected CV ("${shown}") is not the planned one ("${cvName ?? ''}") — not sent`);

  let unsafe: string | null = null;
  let captchaBlocked = false;
  const guard = async (route: Route) => {
    const req = route.request();
    const url = req.url();
    if (!SEND_PATTERN.test(url)) {
      // the CAPTCHA send and "add to my sent jobs" are never made by JobHunter
      captchaBlocked ||= /SendCvCaptcha/i.test(url);
      log.warn({ url: url.split('?')[0] }, 'JobKarov: request aborted (CAPTCHA / add-to-sent are never attempted)');
      return route.abort('blockedbyclient');
    }
    const problems = payloadProblems(req.postData(), { cvId });
    const verdict = problems.length ? `ABORTED: ${problems.join('; ')}` : 'checked: multi=2 (no similar jobs), no "about me" text, the planned CV';
    fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-request.txt`), `${req.method()} ${url}\n${verdict}\n\n${req.postData() ?? ''}`);
    if (problems.length) {
      unsafe = problems.join('; ');
      log.error({ job: job.externalId, problems }, 'JobKarov send request failed the safety check — aborted');
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route(ANY_SEND_PATTERN, guard);
  try {
    const submit = page.locator(`${WIN} button.send`).first();
    if (!(await submit.isVisible().catch(() => false))) throw new ApplyError('unexpected_form', 'the send button was not found in the form');
    const respP = page.waitForResponse((r) => SEND_PATTERN.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 }).catch(() => null);
    const failP = page.waitForEvent('requestfailed', { predicate: (r) => SEND_PATTERN.test(r.url()), timeout: 30_000 }).catch(() => null);
    await submit.click();
    const resp = await Promise.race([respP, failP.then(() => null)]);
    if (unsafe) throw new ApplyError('unsafe_form', `${unsafe} — aborted, nothing sent`);
    if (!resp || !('json' in resp)) {
      const err = clean(await page.locator(`${WIN} .errorDiv, ${WIN} label.error`).allInnerTexts().then((t) => t.join(' ')).catch(() => ''));
      throw new ApplyError('unexpected_form', `no send request after clicking "שלח"${err ? ` — the form says: ${err}` : ''}`);
    }
    const body = await resp.json().catch(async () => ({ result: await resp.text().catch(() => '') }));
    const outcome = parseSendResponse(body);
    // the site's script asks for the CAPTCHA right away: let its (aborted) request settle before the screenshot
    if (outcome.kind === 'needs_manual') await page.waitForTimeout(1500);
    const confirmationText = outcome.kind === 'submitted' ? 'JobKarov: sent (status 1)' : 'message' in outcome ? outcome.message : null;
    const file = `${shotName}-after-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: path.join(config.paths.screenshots, file), fullPage: false }).catch(() => undefined);
    fs.writeFileSync(path.join(config.paths.screenshots, `${shotName}-response.json`), JSON.stringify({ status: resp.status(), body, captchaRequestAborted: captchaBlocked }, null, 2));
    return { outcome, confirmationText, screenshotAfter: file };
  } finally {
    await page.unroute(ANY_SEND_PATTERN, guard).catch(() => undefined);
  }
}

export const fetchAppliedJobs = async (_page?: Page) => jobkarovAppliedSeen();
