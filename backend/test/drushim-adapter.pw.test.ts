/**
 * Runs the real Drushim adapter in headless Chromium against LOCAL fixtures only:
 * every request is intercepted with page.route; anything not served from fixtures is aborted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { drushim } from '../src/sites/drushim/adapter.js';
import type { RawJob } from '../src/sites/types.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const nextDataPage = (nextData: string, body = '') =>
  `<!doctype html><html dir="rtl"><head><title>דרושים</title></head><body>${body}<script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`;
const loadMoreBtn =
  `<button onclick="fetch('https://webapi.drushim.co.il/api/jobs/search?SearchTerm=x&page=1&ssaen=1').then(()=>this.remove())">הצג עוד משרות</button>`;
const ctx = (page: Page, maxPages = 3) => ({ page, maxPages, signal: new AbortController().signal });

let browser: Browser;
let page: Page;
const hits: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    hits.push(url);
    if (url.startsWith('https://www.drushim.co.il/jobs/search/')) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: nextDataPage(fx('drushim-search-ssr.json'), loadMoreBtn) });
    }
    if (/webapi\.drushim\.co\.il\/api\/jobs\/search\?.*page=1/.test(url)) {
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fx('drushim-api-search.json') });
    }
    if (url.startsWith('https://www.drushim.co.il/job/')) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: nextDataPage(fx('drushim-job-ssr.json')) });
    }
    return route.abort();
  });
});
afterAll(async () => browser?.close());

describe('drushim adapter (local fixtures)', () => {
  it('reads SSR results, then follows "load more" by capturing the XHR', async () => {
    const out: RawJob[] = [];
    for await (const j of drushim.search({ keyword: 'full stack' }, ctx(page))) out.push(j);
    expect(out).toHaveLength(5); // 3 SSR + 2 from the page=1 XHR; button disappears → stop
    expect(out.slice(0, 3).every((j) => !j.detailsFetched)).toBe(true);
    expect(out[3]!.detailsFetched).toBe(true);
    expect(hits.some((u) => u.includes('/jobs/search/full%20stack/'))).toBe(true);
  });

  it('getDetails parses the job page', async () => {
    const d = await drushim.getDetails({ url: 'https://www.drushim.co.il/job/38822551/3d25aca1/', externalId: '38822551' }, ctx(page, 1));
    expect(d?.requirementsText).toContain('React');
  });

  it('throws BlockedError on a challenge page instead of continuing', async () => {
    await page.unroute('**/*');
    await page.route('**/*', (route) =>
      route.request().url().startsWith('https://www.drushim.co.il/')
        ? route.fulfill({ contentType: 'text/html', body: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>' })
        : route.abort(),
    );
    const iter = drushim.search({ keyword: 'x' }, ctx(page, 1))[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/blocked/);
  });
});
