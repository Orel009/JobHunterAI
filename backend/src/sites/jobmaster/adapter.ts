/**
 * JobMaster discovery: the site's own server-rendered pages, read like a person browsing — search results
 * (/jobs/?q=… → /jobs/q-…/?currPage=N), the job page, and the "jobs I applied to" list. Human pacing between pages
 * and the same per-run budget as Drushim; any bot-protection page stops the run (never bypassed).
 */
import type { Page } from 'playwright';
import type { SearchQuery, SiteAdapter, SiteContext } from '../types.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import { JM_BASE, SENT_LIST_URL, parseJobPage, parseSearchPage, parseSentList, searchUrl } from './parse.js';

async function load(page: Page, url: string): Promise<string> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  return page.content();
}

/** Every job key this account applied to on JobMaster, with the date sent (the site's own list, all pages). */
export async function fetchJobMasterApplied(page: Page): Promise<Map<string, string | null>> {
  const first = parseSentList(await load(page, SENT_LIST_URL));
  const all = new Map(first.applied);
  for (let p = 2; p <= Math.min(first.lastPage, 30); p++) {
    await pace(2000, 4000);
    const next = parseSentList(await load(page, `${SENT_LIST_URL}?currPage=${p}`));
    for (const [k, v] of next.applied) all.set(k, v);
  }
  if (first.total !== null && all.size < first.total) log.warn({ site: 'jobmaster', read: all.size, total: first.total }, 'applied list: fewer jobs read than the site counts');
  return all;
}

export const jobmaster: SiteAdapter = {
  id: 'jobmaster',
  displayName: 'JobMaster',
  loginUrl: `${JM_BASE}/`,

  async *search(query: SearchQuery, ctx: SiteContext) {
    const { page } = ctx;
    const url = searchUrl(query.keyword);
    log.info({ site: 'jobmaster', url }, 'search');
    const first = parseSearchPage(await load(page, url));
    for (const j of first.jobs) yield j;
    // the site redirects ?q=Full+Stack to /jobs/q-Full-Stack/; later pages are ?currPage=N on that address
    const base = page.url().split('?')[0]!;
    for (let p = 2; p <= Math.min(ctx.maxPages, first.lastPage); p++) {
      if (ctx.signal.aborted) return;
      await pace();
      const next = parseSearchPage(await load(page, `${base}?currPage=${p}`));
      log.info({ site: 'jobmaster', page: p, count: next.jobs.length }, 'results page');
      if (next.jobs.length === 0) break;
      for (const j of next.jobs) yield j;
    }
  },

  async getDetails(job, ctx) {
    await pace();
    return parseJobPage(await load(ctx.page, job.url), job.externalId);
  },

  async appliedJobs(ctx) {
    return fetchJobMasterApplied(ctx.page);
  },
};
