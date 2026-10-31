/**
 * Assisted-only sources: LinkedIn and Indeed. Jobs come from their alert emails; applying is done by the user in
 * their own browser. JobHunter never logs in to them, never opens them in the automated browser, never clicks or
 * submits anything there and never scrapes their pages.
 */
import { isLinkedInHost } from '../linkedin/parse.js';

export const ASSISTED_SITES = ['linkedin', 'indeed'] as const;
export type AssistedSite = (typeof ASSISTED_SITES)[number];
export const isAssistedSite = (site: string): site is AssistedSite => (ASSISTED_SITES as readonly string[]).includes(site);
export const SITE_LABEL: Record<AssistedSite, string> = { linkedin: 'LinkedIn', indeed: 'Indeed' };

/** indeed.com, any subdomain (il.indeed.com, cts.indeed.com, apply.indeed.com…) and Indeed's country domains. */
export function isIndeedHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /(^|\.)indeed\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/.test(h) || /(^|\.)indeedapply\.com$/.test(h);
  } catch {
    return false;
  }
}

/** Hosts the automated browser must never load. */
export const isAssistedOnlyHost = (url: string): boolean => isLinkedInHost(url) || isIndeedHost(url);
