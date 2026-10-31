/**
 * Jobnet discovery: the site's own free-text search (/jobs?searchtype=freesearch&freetxt=…), its page buttons (an
 * ASP.NET postback, clicked like a person would), and the job page. Result cards carry the full description and
 * requirements. Human pacing and the same per-run budget as Drushim; any bot-protection page stops the run.
 * Jobs this account already sent a CV to are marked on the cards ("שלחת קורות חיים למשרה זו בתאריך …").
 */
import type { Page } from 'playwright';
import type { SearchQuery, SiteAdapter, SiteContext } from '../types.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { log } from '../../log.js';
import { JN_BASE, parseJobPage, parseResults } from './parse.js';

export const freeSearchUrl = (term: string) => `${JN_BASE}/jobs?searchtype=freesearch&freetxt=${encodeURIComponent(term)}`;

async function load(page: Page, url: string): Promise<string> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  return page.content();
}

/** Jobs seen with the "you sent a CV" mark during this process (job id → date). */
const appliedSeen = new Map<string, string | null>();

export const jobnet: SiteAdapter = {
  id: 'jobnet',
  displayName: 'Jobnet',
  loginUrl: `${JN_BASE}/`,

  async *search(query: SearchQuery, ctx: SiteContext) {
    const { page } = ctx;
    const url = freeSearchUrl(query.keyword);
    log.info({ site: 'jobnet', url }, 'search');
    const first = parseResults(await load(page, url));
    for (const j of first.jobs) {
      const on = (j.raw as { appliedOn?: string | null }).appliedOn;
      if (on) appliedSeen.set(j.externalId, on === 'yes' ? null : on);
      yield j;
    }
    for (let p = 1; p < Math.min(ctx.maxPages, first.pages); p++) {
      if (ctx.signal.aborted) return;
      const btn = page.locator(`#ContentPlaceHolder1_ucSearhRes_rptPaging_btnPage_${p}`).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      await pace();
      const nav = page.waitForNavigation({ timeout: 30_000 }).catch(() => null);
      await btn.click();
      await nav;
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
      await assertNotBlocked(page);
      const next = parseResults(await page.content());
      log.info({ site: 'jobnet', page: p + 1, count: next.jobs.length }, 'results page');
      if (!next.jobs.length) break;
      for (const j of next.jobs) {
        const on = (j.raw as { appliedOn?: string | null }).appliedOn;
        if (on) appliedSeen.set(j.externalId, on === 'yes' ? null : on);
        yield j;
      }
    }
  },

  async getDetails(job, ctx) {
    await pace();
    return parseJobPage(await load(ctx.page, job.url), job.externalId);
  },

  /** Jobnet has no applied-jobs list to read without its scripts: the cards seen in this run carry the mark. */
  async appliedJobs() {
    return new Map(appliedSeen);
  },
};

export const jobnetAppliedSeen = () => new Map(appliedSeen);
