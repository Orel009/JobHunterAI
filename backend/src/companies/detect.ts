/**
 * Which ATS a company uses, from a careers URL or a job link: first the address itself, then (only if needed) ONE plain
 * request to that page (no browser, no cookies) and its HTML scanned for the ATS's links and embeds.
 * Supported for reading jobs: Greenhouse, Comeet, SmartRecruiters, Workable. Detected only: Lever, Ashby.
 */
export type Ats = 'greenhouse' | 'comeet' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'unknown';
export const SUPPORTED_ATS: readonly Ats[] = ['greenhouse', 'comeet', 'smartrecruiters', 'workable'];
export const ATS_LABEL: Record<Ats, string> = {
  greenhouse: 'Greenhouse',
  comeet: 'Comeet',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  unknown: 'unknown',
};

export interface Detected {
  ats: Ats;
  /** Greenhouse board token / Comeet company UID / Lever, Ashby, Workable, SmartRecruiters company name */
  board: string | null;
  /** Comeet: the company's slug in comeet.com/jobs/{slug}/{UID} */
  slug?: string | null;
  supported: boolean;
  how: 'url' | 'page' | 'probe';
  /** what was matched, or why nothing usable was */
  evidence: string;
}

const NOT_A_BOARD = new Set(['embed', 'v1', 'jobs', 'job_board', 'api', 'boards']);
const COMEET_UID = '[0-9A-F]{2}\\.[0-9A-F]{3}';

const PATTERNS: Array<{ ats: Ats; re: RegExp; board: (m: RegExpMatchArray) => string | null; slug?: (m: RegExpMatchArray) => string | null }> = [
  { ats: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/i, board: (m) => m[1]! },
  { ats: 'greenhouse', re: /greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?(?:[^"'\s]*&)?for=([A-Za-z0-9_-]+)/i, board: (m) => m[1]! },
  { ats: 'greenhouse', re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9_-]+)/i, board: (m) => (NOT_A_BOARD.has(m[1]!.toLowerCase()) ? null : m[1]!) },
  { ats: 'comeet', re: new RegExp(`comeet\\.com?/(?:jobs|careers)/([A-Za-z0-9_-]+)/(${COMEET_UID})`, 'i'), board: (m) => m[2]!.toUpperCase(), slug: (m) => m[1]! },
  { ats: 'comeet', re: new RegExp(`careers-api/2\\.0/company/(${COMEET_UID})`, 'i'), board: (m) => m[1]!.toUpperCase() },
  { ats: 'comeet', re: new RegExp(`"company_uid"\\s*:\\s*"(${COMEET_UID})"`, 'i'), board: (m) => m[1]!.toUpperCase() },
  { ats: 'lever', re: /(?:jobs(?:\.eu)?\.lever\.co|api(?:\.eu)?\.lever\.co\/v0\/postings)\/([A-Za-z0-9_.-]+)/i, board: (m) => m[1]! },
  { ats: 'ashby', re: /(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([A-Za-z0-9_.%-]+)/i, board: (m) => decodeURIComponent(m[1]!) },
  // Workable: apply.workable.com/{account}/ (and its job / apply pages), {account}.workable.com
  { ats: 'workable', re: /apply\.workable\.com\/(?:api\/v\d\/(?:widget\/)?accounts\/)?([a-z0-9-]+)(?=\/|$|\?)/i, board: (m) => (/^(j|api|jobs)$/i.test(m[1]!) ? null : m[1]!.toLowerCase()) },
  { ats: 'workable', re: /^https?:\/\/([a-z0-9-]+)\.workable\.com/i, board: (m) => (/^(apply|www|jobs|careers|help|resources)$/i.test(m[1]!) ? null : m[1]!.toLowerCase()) },
  // SmartRecruiters: the "Easy apply" link (…/oneclick-ui/company/{id}/…), the API, a job page or the careers page
  { ats: 'smartrecruiters', re: /smartrecruiters\.com\/oneclick-ui\/company\/([A-Za-z0-9_-]+)/i, board: (m) => m[1]! },
  { ats: 'smartrecruiters', re: /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/i, board: (m) => m[1]! },
  { ats: 'smartrecruiters', re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, board: (m) => (/^(oneclick-ui|sr-jobs|static)$/i.test(m[1]!) ? null : m[1]!) },
];

const result = (ats: Ats, board: string | null, how: Detected['how'], evidence: string, slug: string | null = null): Detected => ({
  ats,
  board,
  slug,
  supported: SUPPORTED_ATS.includes(ats) && !!board,
  how,
  evidence,
});

/** From the address alone (an ATS-hosted careers page or job link). */
export function detectFromUrl(url: string): Detected | null {
  for (const p of PATTERNS) {
    const m = url.match(p.re);
    const board = m ? p.board(m) : null;
    if (m && board) return result(p.ats, board, 'url', m[0], p.slug?.(m) ?? null);
  }
  return null;
}

/** From a page's HTML: the most frequent supported match first, else any match, else an embed without an id. */
export function detectFromHtml(html: string): Detected | null {
  const hits = new Map<string, { d: Detected; n: number }>();
  for (const p of PATTERNS) {
    for (const m of html.matchAll(new RegExp(p.re.source, 'gi'))) {
      const board = p.board(m);
      if (!board) continue;
      const key = `${p.ats}:${board.toLowerCase()}`;
      const prev = hits.get(key);
      const slug = p.slug?.(m) ?? prev?.d.slug ?? null;
      hits.set(key, { d: result(p.ats, prev?.d.board ?? board, 'page', m[0], slug), n: (prev?.n ?? 0) + 1 });
    }
  }
  const ranked = [...hits.values()].sort((a, b) => Number(b.d.supported) - Number(a.d.supported) || b.n - a.n);
  if (ranked.length) return ranked[0]!.d;
  // an ATS widget whose id is not in the HTML (e.g. a Comeet list rendered by the company's own site)
  if (/class="[^"]*\bcomeet-|comeet-careers|comeet\.co/i.test(html))
    return result('comeet', null, 'page', 'a Comeet widget, but no company UID in the page — paste one job link from this company (a comeet.com/jobs/… address)');
  if (/[?&]gh_jid=\d+/.test(html)) return result('greenhouse', null, 'page', 'Greenhouse job ids (gh_jid), but no board name in the page — paste a job-boards.greenhouse.io link');
  return null;
}

/**
 * Name variants to try on the ATS APIs: from the name you gave and from the site's domain ("Similarweb" / similarweb.com
 * → "similarweb"; careers.wix.com → "wix"; matrix.co.il → "matrix"). At most two.
 */
export function nameVariants(name: string, url: string): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    const x = v.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    if (x.length >= 2 && !out.includes(x)) out.push(x);
  };
  if (/[a-z]/i.test(name)) add(name);
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, '').split('.');
    // the registrable name: skip careers. / jobs. and two-part endings (co.il, com.au)
    const ends = labels.length > 2 && /^(co|com|org|net|ac|gov)$/.test(labels[labels.length - 2]!) ? 3 : 2;
    add(labels[labels.length - ends] ?? '');
  } catch {
    /* not an address */
  }
  return out.slice(0, 2);
}

/**
 * When neither the address nor the page shows the ATS: the public APIs asked directly, by name variant — Greenhouse
 * first (its board endpoint answers yes / no), then Lever and Ashby (detected only), then Workable and SmartRecruiters
 * (only an account with jobs counts). At most 10 light requests; Comeet cannot be asked by name (its API
 * needs the company UID). A SmartRecruiters id often differs from the name (Wix is "Wix2"): one job link finds it.
 */
export async function probeAts(name: string, url: string, fetchImpl: typeof fetch = fetch): Promise<Detected | null> {
  const variants = nameVariants(name, url);
  const probes: Array<{ ats: Ats; url: (v: string) => string; ok: (r: Response) => Promise<boolean> }> = [
    { ats: 'greenhouse', url: (v) => `https://boards-api.greenhouse.io/v1/boards/${v}`, ok: async (r) => r.status === 200 },
    { ats: 'lever', url: (v) => `https://api.lever.co/v0/postings/${v}?limit=1&mode=json`, ok: async (r) => r.status === 200 && Array.isArray(await r.json().catch(() => null)) },
    { ats: 'ashby', url: (v) => `https://api.ashbyhq.com/posting-api/job-board/${v}`, ok: async (r) => r.status === 200 },
    // Workable: the widget list of a real account (404 otherwise); only an account with jobs counts
    {
      ats: 'workable',
      url: (v) => `https://apply.workable.com/api/v1/widget/accounts/${v}`,
      ok: async (r) => r.status === 200 && (((await r.json().catch(() => null)) as { jobs?: unknown[] } | null)?.jobs?.length ?? 0) > 0,
    },
    // SmartRecruiters answers 200 for any name: only a company with jobs counts
    { ats: 'smartrecruiters', url: (v) => `https://api.smartrecruiters.com/v1/companies/${v}/postings?limit=1`, ok: async (r) => r.status === 200 && Number(((await r.json().catch(() => null)) as { totalFound?: number } | null)?.totalFound ?? 0) > 0 },
  ];
  for (const p of probes) {
    for (const v of variants) {
      const r = await fetchImpl(p.url(v), { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (r && (await p.ok(r))) return result(p.ats, v, 'probe', `${ATS_LABEL[p.ats]} has a public job board "${v}"`);
    }
  }
  return null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The address first; else one plain GET of the page (Node fetch: never the automated browser). */
export async function detectAts(url: string, fetchImpl: typeof fetch = fetch, name = ''): Promise<Detected & { finalUrl: string; pageStatus: number | null }> {
  const d = await detectFromAddressOrPage(url, fetchImpl);
  if (d.ats !== 'unknown' && d.board) return d;
  // nothing usable from the page: ask the ATS APIs by name (a widget without its id, a page built by script, …)
  const probed = await probeAts(name, d.finalUrl || url, fetchImpl);
  if (probed) return { ...probed, finalUrl: d.finalUrl, pageStatus: d.pageStatus };
  return { ...d, evidence: `${d.evidence.replace(/ — paste one job link.*$/, '')} — paste one job link from this company` };
}

async function detectFromAddressOrPage(url: string, fetchImpl: typeof fetch): Promise<Detected & { finalUrl: string; pageStatus: number | null }> {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ...result('unknown', null, 'url', 'not a valid address'), finalUrl: url, pageStatus: null };
  }
  const direct = detectFromUrl(u.href);
  if (direct) return { ...direct, finalUrl: u.href, pageStatus: null };
  try {
    const r = await fetchImpl(u.href, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(20_000) });
    const finalUrl = r.url || u.href;
    const fromRedirect = detectFromUrl(finalUrl);
    if (fromRedirect) return { ...fromRedirect, finalUrl, pageStatus: r.status };
    if (!r.ok) return { ...result('unknown', null, 'page', `the page answered HTTP ${r.status}`), finalUrl, pageStatus: r.status };
    const html = (await r.text()).slice(0, 4_000_000);
    const found = detectFromHtml(html);
    if (found) return { ...found, finalUrl, pageStatus: r.status };
    const jsOnly = html.length < 50_000 && /<script/i.test(html);
    return {
      ...result('unknown', null, 'page', jsOnly ? 'no ATS link in the page (it is probably built by script) — paste one job link from this company instead' : 'no ATS link or embed found in the page'),
      finalUrl,
      pageStatus: r.status,
    };
  } catch (e) {
    return { ...result('unknown', null, 'page', `the page could not be read (${e instanceof Error ? e.message : String(e)})`), finalUrl: u.href, pageStatus: null };
  }
}
