/**
 * LinkedIn job-alert emails → jobs. Pure functions, no network and no browser: the HTML part is read as a flat
 * sequence of text lines, where a line inside a link to /jobs/view/<id> starts a job card (its text is the title)
 * and the next lines up to the following card hold "Company · Location" (or company and location on two lines).
 * The text/plain part ("Title / Company / Location / View job: <url>") is the fallback.
 */

export interface AlertJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  /** canonical https://www.linkedin.com/jobs/view/<id>/ (tracking parameters dropped) */
  url: string;
}

/** LinkedIn's job-alert sender. Only messages from this address are read. */
export const ALERT_SENDER = 'jobalerts-noreply@linkedin.com';

const JOB_LINK = /^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i;

export const canonicalJobUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;

/** The LinkedIn job id in a job link, or null. */
export function linkedInJobId(href: string): string | null {
  return JOB_LINK.exec(href.trim())?.[1] ?? null;
}

/** linkedin.com or any subdomain (used to keep LinkedIn out of the automated browser). */
export function isLinkedInHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'linkedin.com' || h.endsWith('.linkedin.com') || h === 'lnkd.in';
  } catch {
    return false;
  }
}

// Badges and counters that sit between cards, in English and Hebrew. Never a company or a location.
const NOISE = [
  /^easy apply$/i,
  /^actively (recruiting|hiring)$/i,
  /^promoted$/i,
  /^new$/i,
  /^be an early applicant$/i,
  /^apply with (your )?(resume|profile)/i,
  /^(view|see) (job|all jobs|more jobs)/i,
  /^\d+\s+(connections?|alumni|applicants?|school alumni)/i,
  /(connections?|alumni) work here$/i,
  /^your profile matches/i,
  /^responses managed off linkedin$/i,
  /^this company is actively hiring$/i,
  /^(fast growing|top applicant)/i,
  /^הגשת מועמדות (קלה|מהירה)$/,
  /^מגייסים באופן פעיל$/,
  /^מקודם$/,
  /^חדש$/,
  /^צפייה במשר(ה|ות)/,
  /^\d+\s+(קשרים|קשר|בוגרים|מועמדים)/,
  /^(₪|\$|€)\s?\d|^\d[\d,.]*\s?(₪|k)\b/i,
];
const isNoise = (s: string) => NOISE.some((r) => r.test(s));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK = new Set(['p', 'div', 'td', 'th', 'tr', 'table', 'li', 'ul', 'ol', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'center', 'hr']);
const clean = (s: string) => decodeEntities(s).replace(/[‎‏​­]/g, '').replace(/\s+/g, ' ').trim();

interface Line {
  text: string;
  /** job id when the line is inside a job link */
  jobId: string | null;
}

/** HTML → text lines (block elements and <br> break lines; a link change also breaks the line). */
export function htmlLines(html: string): Line[] {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '');
  const lines: Line[] = [];
  let cur = '';
  let curJob: string | null = null;
  let linkJob: string | null = null;
  const flush = () => {
    const t = clean(cur);
    if (t) lines.push({ text: t, jobId: curJob });
    cur = '';
  };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[4] !== undefined) {
      curJob = linkJob; // lines are flushed at every link boundary, so all of cur shares one link
      cur += m[4];
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (tag === 'a') {
      flush();
      if (closing) linkJob = null;
      else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3] ?? '');
        linkJob = linkedInJobId(decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''));
      }
    } else if (BLOCK.has(tag)) flush();
  }
  flush();
  return lines;
}

function companyAndLocation(details: string[]): { company: string; location: string } {
  const first = details[0] ?? '';
  const dot = first.split(/\s+[·•|]\s+/);
  if (dot.length >= 2) return { company: dot[0]!.trim(), location: dot.slice(1).join(', ').trim() };
  return { company: first, location: details[1] ?? '' };
}

/** Jobs in a job-alert email's HTML part. A job linked more than once (logo + title) is returned once. */
export function parseAlertHtml(html: string): AlertJob[] {
  const lines = htmlLines(html);
  const out = new Map<string, AlertJob>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.jobId || out.has(l.jobId) || isNoise(l.text)) continue;
    const details: string[] = [];
    for (let k = i + 1; k < lines.length && details.length < 2; k++) {
      const n = lines[k]!;
      if (n.jobId && n.jobId !== l.jobId) break;
      // same job id: a card wrapped in one link, where company and location are inside it too
      if (n.text === l.text || isNoise(n.text)) continue;
      details.push(n.text);
    }
    out.set(l.jobId, { externalId: l.jobId, title: l.text, ...companyAndLocation(details), url: canonicalJobUrl(l.jobId) });
  }
  return [...out.values()];
}

/** Fallback: "Title\nCompany\nLocation\nView job: <url>" blocks of the text/plain part. */
export function parseAlertText(text: string): AlertJob[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const out = new Map<string, AlertJob>();
  for (let i = 0; i < lines.length; i++) {
    const url = /(https?:\/\/\S*linkedin\.com\/\S*jobs\/view\/\S+)/i.exec(lines[i]!)?.[1];
    const id = url ? linkedInJobId(url) : null;
    if (!id || out.has(id)) continue;
    const before: string[] = [];
    for (let k = i - 1; k >= 0 && before.length < 3; k--) {
      const t = lines[k]!;
      if (!t || isNoise(t)) continue;
      if (/^-{3,}$|^={3,}$/.test(t) || /https?:\/\//.test(t)) break;
      before.unshift(t);
    }
    if (before.length === 0) continue;
    const [title, ...rest] = before;
    out.set(id, { externalId: id, title: title!, ...companyAndLocation(rest), url: canonicalJobUrl(id) });
  }
  return [...out.values()];
}

/** HTML first; the text part when the HTML yields nothing. */
export function parseAlertEmail(mail: { html?: string | null; text?: string | null }): AlertJob[] {
  const fromHtml = mail.html ? parseAlertHtml(mail.html) : [];
  return fromHtml.length ? fromHtml : mail.text ? parseAlertText(mail.text) : [];
}

// ---------- English LinkedIn locations → the Hebrew names used in preferences.locations ----------
const PLACES: Array<[RegExp, string[]]> = [
  [/tel aviv/i, ['תל אביב']],
  [/haifa/i, ['חיפה']],
  [/jerusalem/i, ['ירושלים']],
  [/herzliya/i, ['הרצליה', 'השרון']],
  [/petah? tikva/i, ['פתח תקווה']],
  [/ramat gan/i, ['רמת גן']],
  [/givatayim/i, ['גבעתיים']],
  [/netanya/i, ['נתניה', 'השרון']],
  [/ra'?anana/i, ['רעננה', 'השרון']],
  [/kfar saba/i, ['כפר סבא', 'השרון']],
  [/hod hasharon/i, ['הוד השרון', 'השרון']],
  [/even yehuda/i, ['אבן יהודה', 'השרון']],
  [/kfar yona/i, ['כפר יונה', 'השרון']],
  [/rishon le?z?ion/i, ['ראשון לציון']],
  [/rehovot/i, ['רחובות']],
  [/ness ziona/i, ['נס ציונה']],
  [/holon/i, ['חולון']],
  [/bat yam/i, ['בת ים']],
  [/bnei brak/i, ['בני ברק']],
  [/or yehuda/i, ['אור יהודה']],
  [/airport city/i, ['איירפורט סיטי']],
  [/yehud/i, ['יהוד']],
  [/kiryat ono/i, ['קריית אונו']],
  [/rosh ha'?ayin/i, ['ראש העין']],
  [/modi'?in/i, ['מודיעין']],
  [/shoham/i, ['שוהם']],
  [/lod\b/i, ['לוד']],
  [/ramla/i, ['רמלה']],
  [/yavne/i, ['יבנה']],
  [/ashdod/i, ['אשדוד']],
  [/ashkelon/i, ['אשקלון']],
  [/be'?er sheva|beersheba/i, ['באר שבע']],
  [/kiryat gat/i, ['קריית גת']],
  [/hadera/i, ['חדרה']],
  [/caesarea/i, ['קיסריה']],
  [/zichron|zikhron/i, ['זכרון יעקב']],
  [/pardes hanna/i, ['פרדס חנה']],
  [/yokneam|yokne'?am/i, ['יקנעם']],
  [/tirat (carmel|hacarmel)/i, ['טירת כרמל']],
  [/kiryat (ata|bialik|motzkin|yam)|krayot/i, ['הקריות', 'קריות']],
  [/akko|\bacre\b/i, ['עכו']],
  [/karmiel/i, ['כרמיאל']],
  [/nahariya/i, ['נהריה']],
  [/nazareth|nof hagalil/i, ['נצרת']],
  [/migdal ha'?emek/i, ['מגדל העמק']],
  [/afula/i, ['עפולה']],
  [/tiberias/i, ['טבריה']],
  [/eilat/i, ['אילת']],
  [/center district|central district/i, ['מרכז']],
  [/haifa district/i, ['חיפה']],
  [/northern district/i, ['צפון']],
  [/southern district/i, ['דרום']],
  [/\bremote\b/i, ['remote', 'מהבית']],
  [/\bhybrid\b/i, ['hybrid', 'היברידי']],
  [/^\s*israel\s*(\(|$)/i, ['כל הארץ']],
];

/** Hebrew city / region names for an English LinkedIn location, matched by the location prefilter like a site region. */
export function hebrewPlaces(location: string): string[] {
  return [...new Set(PLACES.filter(([re]) => re.test(location)).flatMap(([, he]) => he))];
}
