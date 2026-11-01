/**
 * Comeet Careers API (verified 2026-11-01): the positions of a company, read with its company UID and the token the
 * company publishes on its own public Comeet careers page (comeet.com/jobs/{slug}/{UID}). Read-only: the token is used
 * for nothing but this one positions request, at most once per company per run. Applying is done by you on the hosted
 * page (it has reCAPTCHA); no submit endpoint is used.
 */
import { decodeEntities } from '../linkedin/parse.js';
import { text } from '../sites/jobmaster/parse.js';
import type { RawJob } from '../sites/types.js';

export const comeetPageUrl = (slug: string | null | undefined, uid: string) => `https://www.comeet.com/jobs/${encodeURIComponent(slug || 'company')}/${uid}`;
export const comeetPositionsUrl = (uid: string, token: string) =>
  `https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(uid)}/positions?token=${encodeURIComponent(token)}&details=true`;

/** The company UID and token from the company's public Comeet page (its COMPANY_DATA). */
export function comeetToken(html: string, uid?: string): { uid: string; token: string } | null {
  const u = /"company_uid"\s*:\s*"([0-9A-F]{2}\.[0-9A-F]{3})"/i.exec(html)?.[1]?.toUpperCase();
  const t = /"token"\s*:\s*"([A-Za-z0-9]{16,64})"/.exec(html)?.[1];
  if (!u || !t) return null;
  if (uid && u !== uid.toUpperCase()) return null; // another company's page
  return { uid: u, token: t };
}

export interface ComeetPosition {
  uid: string;
  name: string;
  department?: string | null;
  location?: { name?: string | null; city?: string | null; country?: string | null; is_remote?: boolean | null } | null;
  employment_type?: string | null;
  experience_level?: string | null;
  workplace_type?: string | null;
  url_comeet_hosted_page?: string | null;
  url_active_page?: string | null;
  /** the API address of the position, WITH the token: never stored or shown */
  position_url?: string | null;
  time_updated?: string | null;
  company_name?: string | null;
  is_internal?: boolean | null;
  details?: Array<{ name?: string; value?: string | null; order?: number }> | null;
}

/** "Tel Aviv" / "Tel Aviv-Yafo" / "IL" → one line, with "Israel" for the country so the location rules read it. */
export function comeetLocation(p: ComeetPosition): string {
  const l = p.location ?? {};
  const country = l.country === 'IL' ? 'Israel' : (l.country ?? '');
  const parts = [l.name ?? '', l.city ?? '', country, l.is_remote ? 'Remote' : ''].map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

const detail = (p: ComeetPosition, re: RegExp) =>
  (p.details ?? [])
    .filter((d) => re.test(d.name ?? ''))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((d) => text(decodeEntities(d.value ?? '')))
    .filter(Boolean)
    .join('\n\n');

export function comeetToRawJob(uid: string, company: string, p: ComeetPosition): RawJob {
  const requirements = detail(p, /requirement|qualification|דרישות/i);
  const description = detail(p, /^(?!.*(requirement|qualification|דרישות)).*/i);
  // never position_url: it is the API address and carries the token
  const url = p.url_active_page || p.url_comeet_hosted_page || '';
  return {
    site: 'comeet',
    externalId: `${uid}:${p.uid}`,
    company: company || p.company_name || uid,
    title: (p.name ?? '').trim(),
    location: comeetLocation(p),
    descriptionText: description,
    requirementsText: requirements,
    url,
    postedAt: p.time_updated ?? null,
    applyType: 'external',
    applyTarget: p.url_comeet_hosted_page || url,
    language: /[א-ת]/.test(`${p.name} ${description}`) ? 'he' : 'en',
    detailsFetched: true,
    // only what the pipeline needs: no recruiter e-mails, no arrival instructions
    raw: { ats: 'comeet', board: uid, positionUid: p.uid, department: p.department ?? null, experienceLevel: p.experience_level ?? null, workplaceType: p.workplace_type ?? null, country: p.location?.country ?? null },
  };
}
