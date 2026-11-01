/**
 * Greenhouse public Job Board API (no login; verified 2026-11-01): one request per company for every job with its full
 * description (?content=true), and, when you open a job in the assisted panel, its application questions
 * (?questions=true). Applying needs the employer's API key or the hosted form (with reCAPTCHA): it is done by you.
 */
import { decodeEntities } from '../linkedin/parse.js';
import { text } from '../sites/jobmaster/parse.js';
import type { FormField } from '../apply/types.js';
import type { RawJob } from '../sites/types.js';

export const GH_API = 'https://boards-api.greenhouse.io/v1/boards';
export const ghListUrl = (board: string) => `${GH_API}/${encodeURIComponent(board)}/jobs?content=true`;
export const ghQuestionsUrl = (board: string, id: string | number) => `${GH_API}/${encodeURIComponent(board)}/jobs/${id}?questions=true`;
/** the hosted application form (the company's own page may embed the same form) */
export const ghFormUrl = (board: string, id: string | number) => `https://job-boards.greenhouse.io/${encodeURIComponent(board)}/jobs/${id}`;

export interface GhJob {
  id: number;
  title: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  updated_at?: string;
  first_published?: string | null;
  company_name?: string;
  content?: string;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string; location?: string | null }>;
}

/** "Tel Aviv" + offices "Tel Aviv, Israel" → one location line. */
export function ghLocation(j: GhJob): string {
  const parts = [j.location?.name ?? '', ...(j.offices ?? []).map((o) => o.location ?? '')].map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].join(' · ');
}

export function ghToRawJob(board: string, company: string, j: GhJob): RawJob {
  const description = text(decodeEntities(j.content ?? ''));
  return {
    site: 'greenhouse',
    externalId: `${board}:${j.id}`,
    company: company || j.company_name || board,
    title: (j.title ?? '').trim(),
    location: ghLocation(j),
    descriptionText: description,
    requirementsText: '',
    url: j.absolute_url || ghFormUrl(board, j.id),
    postedAt: j.first_published ?? j.updated_at ?? null,
    applyType: 'external',
    applyTarget: ghFormUrl(board, j.id),
    language: /[א-ת]/.test(`${j.title} ${description}`) ? 'he' : 'en',
    detailsFetched: true,
    raw: { ats: 'greenhouse', board, jobId: j.id, departments: (j.departments ?? []).map((d) => d.name).filter(Boolean), updatedAt: j.updated_at ?? null },
  };
}

// ---------- application questions ----------
export interface GhQuestion {
  label: string;
  required: boolean;
  description?: string | null;
  fields: Array<{ name: string; type: string; values?: Array<{ label: string; value: string | number }> }>;
}

/** Files (CV, cover letter) are attached by you; the rest become plan fields the profile / answers bank can answer. */
export function ghQuestionFields(questions: GhQuestion[]): FormField[] {
  const out: FormField[] = [];
  questions.forEach((q, i) => {
    const f = q.fields.find((x) => x.type !== 'input_file') ?? null;
    if (!f || q.fields.every((x) => x.type === 'input_file' || (x.type === 'textarea' && q.fields.some((y) => y.type === 'input_file')))) return;
    const label = text(decodeEntities(q.label)).replace(/\s*\*$/, '');
    const key = `gh.${f.name || i}`;
    const opts = (f.values ?? []).map((v) => text(String(v.label)));
    if (f.type === 'multi_value_single_select' || f.type === 'multi_value_multi_select') {
      const yn = opts.length === 2 && opts.every((o) => /^(yes|no|כן|לא)$/i.test(o));
      out.push(yn ? { key, label, type: 'yes_no', required: q.required } : { key, label, type: 'choice', required: q.required, options: opts });
      return;
    }
    out.push({ key, label, type: f.type === 'textarea' ? 'textarea' : 'text', required: q.required });
  });
  return out;
}
