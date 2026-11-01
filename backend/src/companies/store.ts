/**
 * Your target companies: data/companies.yaml (local; never committed). Each one: a careers URL or job link, the ATS
 * detected from it (and its board / company UID), on/off, and the last check. Comeet: the token the company publishes
 * on its public Comeet page is kept here so a run needs only its one positions request.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { config } from '../config.js';
import { nowIso } from '../db/index.js';
import { ATS_LABEL, SUPPORTED_ATS, type Ats, type Detected } from './detect.js';

const AtsEnum = z.enum(['greenhouse', 'comeet', 'lever', 'ashby', 'workable', 'smartrecruiters', 'unknown']);
export const CompanySchema = z.object({
  /** "{ats}:{board}" */
  id: z.string(),
  name: z.string().default(''),
  url: z.string(),
  ats: AtsEnum,
  board: z.string().nullable().default(null),
  slug: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  addedAt: z.string().default(''),
  lastCheck: z
    .object({ at: z.string(), total: z.number().int().nullable(), israel: z.number().int().nullable(), kept: z.number().int().nullable().default(null), error: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  /** Comeet only: the token from the company's public page, and when it was read */
  comeetToken: z.object({ value: z.string(), readAt: z.string() }).nullable().default(null),
});
export type Company = z.infer<typeof CompanySchema>;

const FileSchema = z.object({ companies: z.array(CompanySchema).default([]) });
export const companiesFile = () => path.join(config.dataDir, 'companies.yaml');

const HEADER = `# Your target companies. JobHunter reads their public job lists (Greenhouse, Comeet, SmartRecruiters) once per Run & send; applying
# is done by you in the assisted panel. Add companies on the Companies screen (a careers URL or a job link).
`;

export function loadCompanies(): Company[] {
  const f = companiesFile();
  if (!fs.existsSync(f)) return [];
  const list = FileSchema.parse(YAML.parse(fs.readFileSync(f, 'utf8')) ?? {}).companies;
  // addresses saved with ad tracking (utm_…, gclid…): cleaned, with a short id (kept once, on disk)
  const fixed = list.map((c) => (cleanUrl(c.url) !== c.url ? { ...c, url: cleanUrl(c.url), id: c.ats === 'unknown' || !c.board ? companyId(c.ats, c.board, cleanUrl(c.url)) : c.id } : c));
  if (fixed.some((c, i) => c !== list[i])) saveCompanies(fixed);
  return fixed;
}

/** An address without tracking parameters (utm_*, gclid, gbraid, fbclid, gad_*, …) and fragments. */
export function cleanUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|gad_|gclid|gbraid|wbraid|fbclid|msclkid|mc_|_hs|ref$|source$)/i.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.href;
  } catch {
    return u.trim();
  }
}

export function saveCompanies(list: Company[]): void {
  fs.mkdirSync(path.dirname(companiesFile()), { recursive: true });
  fs.writeFileSync(companiesFile(), HEADER + YAML.stringify({ companies: list }));
}

/** Creates an empty companies.yaml once (it is never filled in for you). */
export function seedCompanies(): void {
  if (!fs.existsSync(companiesFile())) saveCompanies([]);
}

export const isSupported = (c: Pick<Company, 'ats' | 'board'>) => SUPPORTED_ATS.includes(c.ats as Ats) && !!c.board;
/** "{ats}:{board}", or for a company without a board "{ats}:{host}{path}" (short; no query) */
export const companyId = (ats: string, board: string | null, url: string) => {
  if (board) return `${ats}:${board}`;
  try {
    const u = new URL(url);
    return `${ats}:${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.slice(0, 120);
  } catch {
    return `${ats}:${url.slice(0, 120)}`;
  }
};

export function addCompany(d: Detected & { finalUrl?: string }, url: string, name = ''): Company {
  const list = loadCompanies();
  url = cleanUrl(url);
  const id = companyId(d.ats, d.board, url);
  const existing = list.find((c) => c.id === id);
  if (existing) return existing;
  const c = CompanySchema.parse({ id, name: name.trim(), url, ats: d.ats, board: d.board, slug: d.slug ?? null, enabled: d.supported, addedAt: nowIso() });
  saveCompanies([...list, c]);
  return c;
}

export function updateCompany(id: string, patch: Partial<Company>): Company | null {
  const list = loadCompanies();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const next = CompanySchema.parse({ ...list[i], ...patch, id: list[i]!.id });
  // a company on an ATS that is not supported yet can be listed, never turned on
  if (!isSupported(next)) next.enabled = false;
  list[i] = next;
  saveCompanies(list);
  return next;
}

export function removeCompany(id: string): boolean {
  const list = loadCompanies();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  saveCompanies(next);
  return true;
}

export const atsStatus = (c: Pick<Company, 'ats' | 'board'>) =>
  isSupported(c) ? ATS_LABEL[c.ats as Ats] : c.ats === 'unknown' ? 'ATS not detected' : `${ATS_LABEL[c.ats as Ats]}: not supported yet`;
