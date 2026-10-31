import type { Page } from 'playwright';
import type { RawJob, SearchQuery, SiteAdapter, SiteContext } from '../types.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import cfg from './selectors.json' with { type: 'json' };
import {
  extractNextData,
  fromApiJob,
  fromJobPage,
  fromSsrSearchJob,
  jobPageFromNextData,
  ssrSearchJobs,
  type DrushimApiJob,
} from './normalize.js';

const apiSearchRe = new RegExp(cfg.apiSearchPattern);

/** DOM fallback if __NEXT_DATA__ disappears: minimal cards (details are fetched later from the job page). */
async function domCards(page: Page): Promise<RawJob[]> {
  const cards = await page.$$eval(cfg.dom.jobCard, (as) =>
    as.map((a) => ({ href: (a as HTMLAnchorElement).getAttribute('href') ?? '', text: (a.textContent ?? '').trim() })),
  );
  const seen = new Set<string>();
  const out: RawJob[] = [];
  for (const c of cards) {
    const m = c.href.match(/^\/job\/(\d+)\//);
    if (!m?.[1] || seen.has(m[1]) || !c.text) continue;
    seen.add(m[1]);
    out.push({
      site: 'drushim',
      externalId: m[1],
      company: '',
      title: c.text.split('\n')[0]!.slice(0, 200),
      location: '',
      descriptionText: '',
      requirementsText: '',
      url: new URL(c.href, cfg.baseUrl).toString(),
      postedAt: null,
      applyType: 'site_one_click',
      applyTarget: `${cfg.baseUrl}/sendcv.aspx?jobcode=${m[1]}`,
      language: 'he',
      detailsFetched: false,
      raw: { shape: 'dom' },
    });
  }
  return out;
}

export const drushim: SiteAdapter = {
  id: 'drushim',
  displayName: 'Drushim',
  loginUrl: cfg.loginUrl,

  async *search(query: SearchQuery, ctx: SiteContext) {
    const { page } = ctx;
    const url = cfg.searchUrl.replace('{term}', encodeURIComponent(query.keyword));
    log.info({ site: 'drushim', url }, 'search');
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await assertNotBlocked(page, res?.status());

    const nd = extractNextData(await page.content());
    const { jobs, totalPages } = ssrSearchJobs(nd);
    if (jobs.length > 0) {
      for (const j of jobs) yield fromSsrSearchJob(j);
    } else {
      log.warn({ site: 'drushim' }, 'no __NEXT_DATA__ search results; falling back to DOM cards');
      for (const j of await domCards(page)) yield j;
    }

    const pagesAvailable = totalPages ?? Number.POSITIVE_INFINITY;
    for (let p = 1; p < Math.min(ctx.maxPages, pagesAvailable); p++) {
      if (ctx.signal.aborted) return;
      const btn = page.getByText(cfg.loadMoreText, { exact: false }).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await pace();
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
      const respP = page.waitForResponse((r) => apiSearchRe.test(r.url()), { timeout: 25_000 });
      await btn.click();
      const resp = await respP.catch(() => null);
      if (!resp) {
        await assertNotBlocked(page);
        log.warn({ site: 'drushim', page: p }, 'load-more response not seen');
        break;
      }
      await assertNotBlocked(page, resp.status());
      const body = (await resp.json().catch(() => null)) as { ResultList?: DrushimApiJob[] } | null;
      const list = body?.ResultList ?? [];
      log.info({ site: 'drushim', page: p, count: list.length }, 'load-more page');
      if (list.length === 0) break;
      for (const j of list) yield fromApiJob(j);
    }
  },

  async getDetails(job, ctx) {
    const { page } = ctx;
    await pace();
    const res = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await assertNotBlocked(page, res?.status());
    const { job: data, isGone } = jobPageFromNextData(extractNextData(await page.content()));
    if (isGone || !data) return null;
    return fromJobPage(data, job.url);
  },
};
