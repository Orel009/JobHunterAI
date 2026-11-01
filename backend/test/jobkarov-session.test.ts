/**
 * JobKarov session check and login page: the exact reason for every outcome (the site refusing the page with its
 * HTTP 402 "site unavailable" page, a redirect, the login cookie missing, the account lookup not run / failed / empty,
 * logged in), the 402 page counted as a block (never bypassed), and the pre-check before a login window is opened.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { jkSessionVerdict, type JkSessionEvidence } from '../src/sites/jobkarov/apply.js';
import { detectBlock } from '../src/browser/session.js';
import { judgeLoginPage } from '../src/browser/login-page.js';

/** JobKarov's refusal page as served on 2026-11-01 (HTTP 402), trimmed */
const REFUSAL = `<!DOCTYPE html><html><head><title></title></head><body><div id="notfound"><div class="notfound"><div class="notfound-error"><h1>Sorry!</h1></div>
<h2>This page cannot be found.</h2><a href="mailto:support@jobkarov.com?subject=Sorry!-אתר לא זמין - מזהה מספר -6578785">צור קשר - Contact us</a></div></div></body></html>`;

const base: JkSessionEvidence = {
  status: 200,
  blocked: null,
  finalUrl: 'https://www.jobkarov.com/',
  loginCookie: true,
  bootstrap: true,
  userInfo: { requested: true, status: 200, account: true },
  userId: true,
};

describe('JobKarov session verdict: the exact reason', () => {
  it('logged in', () => {
    expect(jkSessionVerdict(base)).toEqual({ state: 'logged_in', detail: 'jobkarov: your account loaded' });
  });
  it('the site refused the page → unknown, with the reason and the cookie state (never logged out)', () => {
    const v = jkSessionVerdict({ ...base, status: 402, blocked: 'refused by the site (HTTP 402, reference 6578785) — the site is not serving this browser / network right now', bootstrap: false, userInfo: { requested: false }, userId: false });
    expect(v.state).toBe('unknown');
    expect(v.detail).toMatch(/HTTP 402, reference 6578785.*login cookie present.*not bypassed/);
  });
  it('a redirect away from the homepage', () => {
    expect(jkSessionVerdict({ ...base, finalUrl: 'https://www.jobkarov.com/Login?ret=/', userId: false })).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/redirected to https:\/\/www\.jobkarov\.com\/Login/) });
  });
  it('not the normal page (its account script is missing)', () => {
    expect(jkSessionVerdict({ ...base, bootstrap: false, userInfo: { requested: false }, userId: false }).detail).toMatch(/account script is missing; login cookie present/);
  });
  it('login cookie missing → logged out', () => {
    expect(jkSessionVerdict({ ...base, loginCookie: false, userInfo: { requested: false }, userId: false })).toEqual({ state: 'logged_out', detail: 'jobkarov: login cookie (UserInfo) missing — log in again' });
  });
  it('cookie present, account lookup not run / failed / found no user', () => {
    expect(jkSessionVerdict({ ...base, userInfo: { requested: false }, userId: false })).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/not requested/) });
    expect(jkSessionVerdict({ ...base, userInfo: { requested: true, status: 500, account: false }, userId: false })).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/failed \(HTTP 500\)/) });
    expect(jkSessionVerdict({ ...base, userInfo: { requested: true, status: 200, account: false }, userId: false })).toMatchObject({ state: 'logged_out', detail: expect.stringMatching(/found no user/) });
  });
});

describe('the refusal page counts as a block', () => {
  let browser: Browser | undefined;
  afterAll(async () => browser?.close());
  it('HTTP 402 with the reference; the same page without a status by its text', async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(REFUSAL);
    expect(await detectBlock(page, 402)).toBe('refused by the site (HTTP 402, reference 6578785) — the site is not serving this browser / network right now');
    expect(await detectBlock(page)).toMatch(/refused by the site/);
    await page.setContent('<html><body><h1>משרות</h1><p>Sorry! This page cannot be found on our old site, try the search.</p></body></html>');
    expect(await detectBlock(page, 200)).toBeNull();
  });
});

describe('login page pre-check', () => {
  const U = 'https://www.jobkarov.com/';
  it('a real page', () => {
    expect(judgeLoginPage(U, 200, U, '<html>JobKarov</html>')).toMatchObject({ ok: true, reason: 'answers with a real page (HTTP 200)' });
  });
  it('the refusal page, 403 / 429, bot protection, not found, another site', () => {
    expect(judgeLoginPage(U, 402, U, REFUSAL)).toMatchObject({ ok: false, reason: expect.stringMatching(/HTTP 402.*reference 6578785/) });
    expect(judgeLoginPage(U, 429, U, '')).toMatchObject({ ok: false, reason: expect.stringMatching(/too many requests/) });
    expect(judgeLoginPage(U, 200, U, '<title>Radware Page</title>')).toMatchObject({ ok: false, reason: expect.stringMatching(/bot protection/) });
    expect(judgeLoginPage(U, 404, U, '')).toMatchObject({ ok: false, reason: 'page not found (HTTP 404)' });
    expect(judgeLoginPage(U, 200, 'https://example.com/', '')).toMatchObject({ ok: false, reason: expect.stringMatching(/another site/) });
  });
});
