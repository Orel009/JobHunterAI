/**
 * Data for the JobHunter Fill extension (local; token-guarded): which JobHunter job the page in your browser belongs to,
 * and what may be filled there — your contact details and links (profile), the CV file to choose, the salary answer by
 * your rules, the Greenhouse form's prepared answers, and your answers bank. Only what you already have: nothing is
 * drafted, nothing invented. "I applied" from the extension marks the job submitted_manual.
 */
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import { Repo, type StoredJob } from '../db/repo.js';
import { AnswersBank } from '../apply/bank.js';
import { applyHelper } from '../linkedin/helper.js';
import { formAnswers, type FormAnswer } from '../companies/answers.js';
import { loadProfile } from '../profile/facts.js';
import { SITES } from '../sites/registry.js';
import { COMPANY_SOURCE_LABEL, SITE_LABEL, isAssistedSite, isCompanySource } from '../alerts/assisted.js';
import { extensionSettings } from './settings.js';
import { makeDrafter } from '../apply/draft.js';
import type { Profile } from '../profile/schema.js';

const isCurrent = (end: string | null) => !end || /present|current|היום|כיום/i.test(end);
/** current roles first, then by end and start date */
const sortKey = (start: string | null, end: string | null) => `${isCurrent(end) ? '9999' : (end ?? '')}|${start ?? ''}`;

/** Work roles (most recent first) in the given language; the description from the role's highlights, kept short. */
export function experienceEntries(p: Profile | null, lang: 'he' | 'en'): FillData['experience'] {
  if (!p) return [];
  const pick = (b: { he: string | null; en: string | null }) => b[lang] ?? b[lang === 'he' ? 'en' : 'he'] ?? '';
  return p.experience
    .filter((e) => e.kind === 'work')
    .sort((a, b) => sortKey(b.start, b.end).localeCompare(sortKey(a.start, a.end)))
    .map((e) => {
      const hl = (e.highlights[lang].length ? e.highlights[lang] : e.highlights[lang === 'he' ? 'en' : 'he']).slice(0, 3);
      return { company: pick(e.company), title: pick(e.title), start: e.start, end: isCurrent(e.end) ? null : e.end, current: isCurrent(e.end), description: hl.map((h) => `• ${h}`).join('\n').slice(0, 600) };
    })
    .filter((e) => e.company && e.title);
}

type Edu = Profile['education'][number];
/** a course (not a degree): set in the profile, else from its name */
export const isCourse = (e: Pick<Edu, 'kind' | 'degree'>): boolean =>
  e.kind ? e.kind === 'course' : /\b(course|bootcamp|certificat\w*|workshop|training)\b|קורס|סדנ|הכשרה|בוטקמפ/i.test(`${e.degree.en ?? ''} ${e.degree.he ?? ''}`);
const newest = (e: Pick<Edu, 'start' | 'end'>) => (isCurrent(e.end) ? '9999' : (e.end ?? e.start ?? ''));

/** Your order (education[].order, 1 = first) where set; otherwise degrees before courses, newest first within each. */
export function orderEducation<T extends Pick<Edu, 'kind' | 'degree' | 'order' | 'start' | 'end'>>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (a.order ?? 100) - (b.order ?? 100) ||
      Number(isCourse(a)) - Number(isCourse(b)) ||
      newest(b).localeCompare(newest(a)) ||
      String(b.start ?? '').localeCompare(String(a.start ?? '')),
  );
}

export function educationEntries(p: Profile | null, lang: 'he' | 'en'): FillData['education'] {
  if (!p) return [];
  const pick = (b: { he: string | null; en: string | null } | undefined) => (b ? (b[lang] ?? b[lang === 'he' ? 'en' : 'he'] ?? '') : '');
  return orderEducation(p.education)
    .map((e) => ({ institution: pick(e.institution), degree: pick(e.degree), field: pick(e.field), city: pick(e.city), start: e.start, end: isCurrent(e.end) ? null : e.end }))
    .filter((e) => e.institution);
}

export interface FillData {
  job: { id: string; title: string; company: string; site: string; siteLabel: string; status: string } | null;
  contact: {
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
    linkedin: string | null;
    github: string | null;
    website: string | null;
  };
  cv: { lang: 'he' | 'en'; file: string | null; reason: string } | null;
  salary: { number: string | null; text: string | null } | null;
  /** Greenhouse: the form's prepared answers, by question field name (the input's id on the form) */
  form: Array<FormAnswer & { name: string | null }>;
  /** your answers bank (question → answer), for questions matched by their label */
  bank: Array<{ question: string; answer: string; type: string; options: string[] | null }>;
  /** the language the profile values are given in (the job's, else the page's, else English) */
  lang: 'he' | 'en';
  /** single values from the profile */
  profile: { currentTitle: string | null; currentCompany: string | null; yearsExperience: number | null };
  /** work roles (most recent first) and education, for Experience / Education entries on the form */
  experience: Array<{ company: string; title: string; start: string | null; end: string | null; current: boolean; description: string }>;
  /** in your order (degrees before courses, newest first, unless you set one); city: the institution's ("school location") */
  education: Array<{ institution: string; degree: string; field: string; city: string; start: string | null; end: string | null }>;
  /** Settings → JobHunter Fill: fill cover letters / messages to the hiring team with an AI draft (default on) */
  fillCoverLetters: boolean;
}

const siteLabel = (site: string) => (isAssistedSite(site) ? SITE_LABEL[site] : isCompanySource(site) ? COMPANY_SOURCE_LABEL[site] : (SITES.find((s) => s.id === site)?.displayName ?? site));

/** An address without the parts that do not identify the job (query except ids, hash, trailing /apply, /). */
export function normalizeJobUrl(u: string): string {
  try {
    const url = new URL(u);
    const keep = ['gh_jid', 'jk', 'vjk', 'currentJobId', 'key', 'positionid'];
    const q = [...url.searchParams].filter(([k]) => keep.includes(k)).map(([k, v]) => `${k}=${v}`).join('&');
    const p = url.pathname.replace(/\/(apply|application)\/?$/i, '').replace(/\/+$/, '');
    return `${url.hostname.replace(/^www\./, '').toLowerCase()}${p}${q ? `?${q}` : ''}`;
  } catch {
    return u.trim();
  }
}

/** The ids an ATS / job site puts in a job address. */
export function jobIdsInUrl(u: string): string[] {
  const ids: string[] = [];
  const m = (re: RegExp) => {
    const x = re.exec(u);
    if (x?.[1]) ids.push(x[1]);
  };
  m(/[?&]gh_jid=(\d+)/);
  m(/greenhouse\.io\/[^/]+\/jobs\/(\d+)/i);
  m(/comeet\.com?\/jobs\/[^/]+\/[0-9A-F]{2}\.[0-9A-F]{3}\/[^/]+\/([0-9A-F]{2}\.[0-9A-F]{3})/i);
  m(/lever\.co\/[^/]+\/([0-9a-f-]{36})/i);
  m(/ashbyhq\.com\/[^/]+\/([0-9a-f-]{36})/i);
  m(/smartrecruiters\.com\/(?!oneclick-ui)[^/]+\/(\d{6,})/i);
  m(/smartrecruiters\.com\/oneclick-ui\/company\/[^/]+\/publication\/([0-9a-f-]{36})/i);
  m(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/i);
  m(/[?&]currentJobId=(\d{6,})/);
  m(/[?&](?:v?jk)=([0-9a-f]{10,})/i);
  return ids;
}

/** The JobHunter job the page belongs to: the same address, else the same ATS / site job id. Not-yet-applied first. */
export function matchJob(db: DB, pageUrl: string): StoredJob | null {
  const repo = new Repo(db);
  const norm = normalizeJobUrl(pageUrl);
  const ids = jobIdsInUrl(pageUrl);
  const rows = db
    .prepare(
      `SELECT id, url, apply_target AS applyTarget, external_id AS externalId, status FROM jobs
        WHERE site IN ('linkedin','indeed','greenhouse','comeet','smartrecruiters') OR status = 'needs_manual' OR (apply_type = 'external' AND apply_target != '')`,
    )
    .all() as Array<{ id: string; url: string; applyTarget: string; externalId: string; status: string }>;
  const score = (r: (typeof rows)[number]) => {
    const urls = [r.url, r.applyTarget].filter(Boolean);
    if (urls.some((x) => normalizeJobUrl(x) === norm)) return 3;
    if (ids.length && ids.some((id) => r.externalId === id || r.externalId.endsWith(`:${id}`) || urls.some((x) => jobIdsInUrl(x).includes(id)))) return 2;
    return 0;
  };
  const open = (s: string) => !/^(submitted|submitted_manual|skipped)/.test(s);
  const best = rows
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(open(b.r.status)) - Number(open(a.r.status)))[0];
  return best ? repo.getJob(best.r.id) : null;
}

export async function fillData(db: DB, job: StoredJob | null, pageLang?: 'he' | 'en'): Promise<FillData> {
  const profile = loadProfile();
  const helper = job ? applyHelper(db, job) : null;
  const lang: 'he' | 'en' = helper?.cv.lang ?? pageLang ?? 'en';
  const pick = (b: { he: string | null; en: string | null } | undefined) => (b ? (b[lang] ?? b[lang === 'he' ? 'en' : 'he'] ?? null) : null);
  const full = pick(profile?.contact.name);
  const [first, ...rest] = (full ?? '').split(/\s+/).filter(Boolean);
  const link = (re: RegExp) => profile?.links.find((l) => re.test(l.id) || re.test(l.label))?.url ?? null;
  const salaryText = helper?.salary.find((s) => /text/.test(s.label))?.value || null;
  const salaryNumber = helper?.salary.find((s) => /number/.test(s.label))?.value || null;
  const form = job ? await formAnswers(db, job).catch(() => null) : null;
  return {
    job: job ? { id: job.id, title: job.title, company: job.company, site: job.site, siteLabel: siteLabel(job.site), status: job.status } : null,
    contact: {
      fullName: full,
      firstName: first ?? null,
      lastName: rest.join(' ') || null,
      email: profile?.contact.email ?? null,
      phone: profile?.contact.phone ?? null,
      // the city for application forms (Profile → Contact), else the CV's
      city: pick(profile?.forms?.city) ?? pick(profile?.contact.city),
      linkedin: link(/linkedin/i),
      github: link(/github/i),
      website: link(/portfolio|website|site|homepage/i),
    },
    cv: helper ? { lang, file: helper.cv.file, reason: helper.cv.reason } : null,
    salary: helper && (salaryText || salaryNumber) ? { number: salaryNumber, text: salaryText } : null,
    form: (form?.answers ?? []).map((a) => ({ ...a, name: a.name ?? null })),
    bank: new AnswersBank(db)
      .active()
      .filter((e) => e.answer)
      .map((e) => ({ question: e.question, answer: e.answer!, type: e.type, options: e.options ?? null })),
    lang,
    profile: (() => {
      const now = experienceEntries(profile, lang)[0];
      return { currentTitle: now?.current ? now.title : null, currentCompany: now?.current ? now.company : null, yearsExperience: profile?.declaredExperience?.totalDevYears ?? null };
    })(),
    experience: experienceEntries(profile, lang),
    education: educationEntries(profile, lang),
    fillCoverLetters: extensionSettings().fillCoverLetters,
  };
}

/**
 * A cover letter / message to the hiring team for the extension (you review it and submit yourself): the draft
 * pipeline (your profile facts only, with fact ids; the unsupported-claim check; the right gender in Hebrew) with the
 * cover-letter rules: 2–4 plain sentences in the job's language, no AI clichés, your writing sample as the style. Without the job's text (a page JobHunter does not know), only the page's job
 * title and company are given, so the draft stays general but true.
 */
export async function coverLetterDraft(
  db: DB,
  o: { job: StoredJob | null; title: string; company: string; label: string; lang: 'he' | 'en' },
  drafter = makeDrafter(loadProfile(), { cache: new Repo(db), mode: 'coverLetter', styleSample: extensionSettings().styleSample }),
): Promise<{ text: string | null; flaggedClaims: string[]; usedFactIds: string[]; error: string | null }> {
  const title = o.job?.title || o.title || 'this role';
  const company = o.job?.company || o.company || 'your company';
  const language = o.job?.language ?? o.lang;
  const jobText = o.job ? `${o.job.descriptionText}\n${o.job.requirementsText}`.trim() : '';
  const question =
    language === 'he'
      ? `${o.label || 'מכתב לצוות הגיוס'}: מכתב קצר לצוות הגיוס על ההתאמה שלי לתפקיד ${title} ב-${company}`
      : `${o.label || 'Message to the hiring team'}: a short note to the hiring team on why I fit the ${title} role at ${company}`;
  const d = await drafter({ key: 'coverLetter', label: question, type: 'textarea', required: false }, { jobTitle: `${title} — ${company}`, jobText: jobText || `${title} at ${company}`, language });
  if (!d.text || d.rejectedReason || d.unanswerable) return { text: null, flaggedClaims: [], usedFactIds: d.usedFactIds, error: d.rejectedReason ?? 'not answerable from your profile facts' };
  return { text: d.text, flaggedClaims: d.flaggedClaims, usedFactIds: d.usedFactIds, error: null };
}

/** "I applied" from the extension: the job is marked applied by hand (once). */
export function markAppliedByHand(db: DB, job: StoredJob): { appliedAt: string; already: boolean } {
  if (job.status === 'submitted' || job.status === 'submitted_manual') return { appliedAt: job.updatedAt ?? nowIso(), already: true };
  const at = nowIso();
  db.prepare("UPDATE jobs SET status = 'submitted_manual', status_reason = ?, applied_manually_at = ?, updated_at = ? WHERE id = ?").run(
    `applied by hand on ${siteLabel(job.site)} at ${at} (JobHunter Fill)`,
    at,
    at,
    job.id,
  );
  return { appliedAt: at, already: false };
}
