/**
 * JobKarov discovery: the site's own search, filtered to your cities (Preferences → locations, mapped to JobKarov's
 * city ids from its city list) and sorted newest first. One results page per search term: the site loads more only
 * by infinite scroll, and paging by address is not possible (its redirect drops the page number), so the city filter
 * plus newest-first is what keeps the first page relevant. Every job comes with its full text in the page's own data
 * (no job page needed), including the "you sent a CV" mark. Human pacing; any bot-protection page stops the run.
 */
import type { Page } from 'playwright';
import type { SearchQuery, SiteAdapter, SiteContext } from '../types.js';
import { assertNotBlocked, pace } from '../../browser/session.js';
import { loadPrefs } from '../../core/prefs.js';
import { log } from '../../log.js';
import { CITIES_URL, JK_BASE, cityIdsFor, parseCities, parseSearchPage, searchUrl } from './parse.js';

async function load(page: Page, url: string): Promise<string> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
  await assertNotBlocked(page, res?.status());
  return page.content();
}

/** Your locations as JobKarov city ids (the site's city list, read once per process). */
let cityCache: { key: string; ids: number[]; unmatched: string[] } | null = null;
export async function cityFilter(page: Page, locations: string[]): Promise<{ ids: number[]; unmatched: string[] }> {
  const key = locations.join('|');
  if (cityCache?.key === key) return cityCache;
  if (!locations.length) return { ids: [], unmatched: [] };
  if (!page.url().startsWith(JK_BASE)) await load(page, `${JK_BASE}/`);
  const r = await page.request.get(CITIES_URL, { timeout: 30_000 });
  const cities = parseCities(await r.text());
  if (!cities.length) throw new Error('JobKarov city list could not be read — not searching without the city filter');
  const m = cityIdsFor(locations, cities);
  if (m.unmatched.length) log.warn({ site: 'jobkarov', unmatched: m.unmatched }, 'locations with no JobKarov city of that name');
  cityCache = { key, ...m };
  return cityCache;
}

/** Jobs seen with the "you sent a CV" mark during this process (job id → date). */
const appliedSeen = new Map<string, string | null>();

export const jobkarov: SiteAdapter = {
  id: 'jobkarov',
  displayName: 'JobKarov',
  loginUrl: `${JK_BASE}/`,

  async *search(query: SearchQuery, ctx: SiteContext) {
    const { page } = ctx;
    const { ids } = await cityFilter(page, loadPrefs().locations);
    const url = searchUrl(query.keyword, ids);
    log.info({ site: 'jobkarov', query: query.keyword, cities: ids.length }, 'search');
    await pace(2000, 4000);
    const r = parseSearchPage(await load(page, url));
    log.info({ site: 'jobkarov', count: r.jobs.length, found: r.found }, 'results page (newest first)');
    for (const [id, on] of r.applied) appliedSeen.set(id, on);
    for (const j of r.jobs) yield j;
  },

  /** The search page already carries the whole job (description, requirements, experience line). */
  async getDetails() {
    return null;
  },

  /** JobKarov's "jobs I sent" list is empty for this account type; the cards seen in this run carry the mark. */
  async appliedJobs() {
    return new Map(appliedSeen);
  },
};

export const jobkarovAppliedSeen = () => new Map(appliedSeen);
