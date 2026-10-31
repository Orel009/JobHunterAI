/** Bot-protection pages must stop a run (never bypassed): the Radware challenge answers HTTP 200. */
import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { detectBlock } from '../src/browser/session.js';

let browser: Browser | undefined;
afterAll(async () => browser?.close());
const check = async (html: string, status = 200) => {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  try {
    return await detectBlock(page, status);
  } finally {
    await page.close();
  }
};

describe('detectBlock', () => {
  it('the Radware "Verifying your browser" page (as seen on AllJobs) → blocked', async () => {
    const radware = '<html><head><title>Radware Page</title></head><body><div>Verifying your browser before proceeding...</div><div>Incident ID: 837c2915-x</div></body></html>';
    expect(await check(radware)).toBe('radware bot protection');
    expect(await check('<title>x</title><body>Verifying your browser before proceeding...</body>')).toBe('radware bot protection');
  });
  it('a normal job page → not blocked', async () => {
    expect(await check('<title>מפתח/ת Full Stack | AllJobs</title><body><h2>מפתח/ת Full Stack</h2><p>מיקום המשרה: נתניה</p></body>')).toBeNull();
  });
});

describe('AllJobs login state (classic site links)', () => {
  it('logout link → logged in; login link only → logged out; neither → unknown', async () => {
    const { allJobsLoginState } = await import('../src/browser/site-session.js');
    expect(allJobsLoginState({ logout: true, login: false })).toBe('logged_in');
    expect(allJobsLoginState({ logout: false, login: true })).toBe('logged_out');
    expect(allJobsLoginState({ logout: false, login: false })).toBe('unknown');
  });
});
