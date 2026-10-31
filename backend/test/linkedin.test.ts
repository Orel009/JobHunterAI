import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import { hebrewPlaces, isLinkedInHost, linkedInJobId, parseAlertEmail, parseAlertHtml, parseAlertText } from '../src/linkedin/parse.js';
import { importAlertEmails, ProcessedEmails } from '../src/linkedin/importer.js';
import { routeExternalApply, supportedSiteJob } from '../src/linkedin/external.js';
import { safeHttpUrl } from '../src/linkedin/open.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { prepareJobs } from '../src/apply/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => fs.readFileSync(path.join(here, 'fixtures', f), 'utf8');

const CARDS = [
  { externalId: '4100000001', title: 'Full Stack Developer', company: 'Acme Software', location: 'Haifa, Haifa District, Israel (Hybrid)', url: 'https://www.linkedin.com/jobs/view/4100000001/' },
  { externalId: '4100000002', title: 'Junior Backend Engineer (Node.js)', company: 'Globex Ltd.', location: 'Tel Aviv-Yafo, Tel Aviv District, Israel', url: 'https://www.linkedin.com/jobs/view/4100000002/' },
  { externalId: '4100000003', title: 'QA Automation Engineer & Tools', company: 'Initech', location: 'Israel (Remote)', url: 'https://www.linkedin.com/jobs/view/4100000003/' },
];

/** Minimal RFC 2045 quoted-printable, to build a raw email like the one IMAP returns. */
const qp = (s: string) =>
  Buffer.from(s, 'utf8')
    .toString('latin1')
    .replace(/[=\x80-\xff]/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    .split('\n')
    .map((line) => line.match(/.{1,72}(?:=[0-9A-F]{2})?/g)?.join('=\r\n') ?? '')
    .join('\r\n');

const rawEmail = (html: string, text: string, messageId = '<alert-1@example.linkedin.com>') =>
  [
    'From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    'To: test.user@example.com',
    'Subject: =?UTF-8?Q?Software_Developer:_Acme_Software_and_more?=',
    `Message-ID: ${messageId}`,
    'Date: Thu, 29 Oct 2026 07:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(text),
    '--b1',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qp(html),
    '--b1--',
    '',
  ].join('\r\n');

describe('LinkedIn job-alert email parsing', () => {
  it('reads title, company, location and a canonical link from the HTML cards (logo + title links)', () => {
    expect(parseAlertHtml(fx('linkedin-alert-cards.html'))).toEqual(CARDS);
  });

  it('reads cards wrapped in a single link, slug job URLs and Hebrew badges', () => {
    expect(parseAlertHtml(fx('linkedin-alert-wrapped.html'))).toEqual([
      { externalId: '4200000011', title: 'מפתח/ת React', company: 'Umbrella Tech', location: 'Kfar Saba, Center District, Israel', url: 'https://www.linkedin.com/jobs/view/4200000011/' },
      { externalId: '4200000012', title: 'Software Engineer', company: 'Hooli Israel', location: 'Petah Tikva, Center District, Israel', url: 'https://www.linkedin.com/jobs/view/4200000012/' },
    ]);
  });

  it('falls back to the text part when the HTML has no job links', () => {
    expect(parseAlertText(fx('linkedin-alert.txt'))).toEqual(CARDS);
    expect(parseAlertEmail({ html: '<p>nothing here</p>', text: fx('linkedin-alert.txt') })).toEqual(CARDS);
  });

  it('decodes a raw quoted-printable email the way IMAP delivers it', async () => {
    const mail = await simpleParser(Buffer.from(rawEmail(fx('linkedin-alert-cards.html'), fx('linkedin-alert.txt'))));
    expect(typeof mail.html).toBe('string');
    expect(parseAlertEmail({ html: mail.html as string, text: mail.text ?? null })).toEqual(CARDS);
  });

  it('only job links count: search, alert-management and other links are ignored', () => {
    expect(linkedInJobId('https://www.linkedin.com/comm/jobs/search?keywords=x')).toBeNull();
    expect(linkedInJobId('https://www.linkedin.com/comm/jobs/alerts')).toBeNull();
    expect(linkedInJobId('https://evil.example.com/jobs/view/4100000001')).toBeNull();
    expect(linkedInJobId('https://il.linkedin.com/jobs/view/4100000002/?x=1')).toBe('4100000002');
  });

  it('maps English LinkedIn locations to the Hebrew names the location filter uses', () => {
    expect(hebrewPlaces('Haifa, Haifa District, Israel (Hybrid)')).toEqual(['חיפה', 'hybrid', 'היברידי']);
    expect(hebrewPlaces('Kfar Saba, Center District, Israel')).toEqual(['כפר סבא', 'השרון', 'מרכז']);
    expect(hebrewPlaces('Israel (Remote)')).toEqual(['remote', 'מהבית', 'כל הארץ']);
    const prefs = PrefsSchema.parse({ locations: ['חיפה', 'הקריות'], filters: { includeTitleKeywords: ['developer'] } });
    const job = (location: string) => ({ title: 'Full Stack Developer', company: 'Acme', location, regions: hebrewPlaces(location) });
    expect(prefilter(job('Haifa, Haifa District, Israel'), prefs).pass).toBe(true);
    expect(prefilter(job('Kiryat Bialik, Haifa District, Israel'), prefs).pass).toBe(true);
    expect(prefilter(job('Eilat, Southern District, Israel'), prefs).pass).toBe(false);
  });
});

describe('LinkedIn import + processed-email dedupe', () => {
  const email = (messageId: string) => ({ messageId, date: '2026-10-29T07:00:00.000Z', html: fx('linkedin-alert-cards.html'), text: null });

  it('imports each email once (by Message-ID) and each job once (by LinkedIn id)', () => {
    const db = openDb(':memory:');
    const first = importAlertEmails(db, [email('<a@x>')]);
    expect(first).toMatchObject({ emails: 1, jobsFound: 3, inserted: 3, known: 0 });
    expect(new ProcessedEmails(db).has('<a@x>')).toBe(true);

    // the same email again (e.g. the next fetch): skipped entirely
    expect(importAlertEmails(db, [email('<a@x>')])).toMatchObject({ emails: 0, skippedEmails: 1, inserted: 0 });
    // another email with the same jobs: processed, but no duplicate rows
    expect(importAlertEmails(db, [email('<b@x>')])).toMatchObject({ emails: 1, jobsFound: 3, inserted: 0, known: 3 });

    const jobs = new Repo(db).listJobs({ site: 'linkedin' }).items;
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ site: 'linkedin', applyType: 'external', applyTarget: '', descriptionText: '', status: 'discovered' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM email_processed').get() as { n: number }).n).toBe(2);
  });

  it('keeps what the user added when the job shows up in a later alert', () => {
    const db = openDb(':memory:');
    importAlertEmails(db, [email('<a@x>')]);
    const repo = new Repo(db);
    const job = repo.listJobs({ site: 'linkedin', q: 'Initech' }).items[0]!;
    db.prepare("UPDATE jobs SET description_text = 'pasted text', details_fetched = 1, status = 'submitted_manual' WHERE id = ?").run(job.id);
    importAlertEmails(db, [email('<b@x>')]);
    expect(repo.getJob(job.id)).toMatchObject({ descriptionText: 'pasted text', status: 'submitted_manual' });
  });
});

describe('LinkedIn is never automated', () => {
  it('src/linkedin/** never imports Playwright, the browser session or a site adapter (transitively)', () => {
    const src = path.join(here, '..', 'src');
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string, from: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(src, file).replace(/\\/g, '/');
      if (/^browser\//.test(rel) || /^sites\/[^/]+\/(adapter|apply)\.ts$/.test(rel) || /^apply\/service\.ts$/.test(rel) || /^pipeline\//.test(rel)) {
        bad.push(`${from} → ${rel}`);
        return;
      }
      const code = fs.readFileSync(file, 'utf8');
      for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (/^(import|export)\s+type\s/.test(m[0])) continue; // type-only: erased at runtime
        const spec = m[1] ?? m[2]!;
        if (/^(playwright|playwright-core|@playwright\/)/.test(spec)) bad.push(`${rel} imports ${spec}`);
        if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')), rel);
      }
    };
    const dir = path.join(src, 'linkedin');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) visit(path.join(dir, f), `linkedin/${f}`);
    expect(seen.size).toBeGreaterThan(6);
    expect(bad).toEqual([]);
  });

  it('every automated browser context aborts requests to LinkedIn', () => {
    const session = fs.readFileSync(path.join(here, '..', 'src', 'browser', 'session.ts'), 'utf8');
    expect(session).toMatch(/ctx\.route\(\(u\) => isLinkedInHost\(u\.href\), \(route\) => route\.abort/);
    for (const u of ['https://www.linkedin.com/jobs/view/1/', 'https://il.linkedin.com/feed', 'https://linkedin.com', 'https://lnkd.in/abc']) expect(isLinkedInHost(u)).toBe(true);
    for (const u of ['https://www.drushim.co.il/', 'https://linkedin.com.evil.example/', 'not a url']) expect(isLinkedInHost(u)).toBe(false);
  });

  it('a LinkedIn job cannot be prepared by the automated apply flow', () => {
    const db = openDb(':memory:');
    importAlertEmails(db, [{ messageId: '<a@x>', date: null, html: fx('linkedin-alert-cards.html'), text: null }]);
    const job = new Repo(db).listJobs({ site: 'linkedin' }).items[0]!;
    expect(() => prepareJobs(db, [job.id])).toThrow(/applied to by hand/);
    expect(new Repo(db).getJob(job.id)!.status).toBe('discovered');
  });

  it('links opened in the system browser must be plain http(s)', () => {
    expect(safeHttpUrl('https://www.linkedin.com/jobs/view/1/?a=1&b=2')).toBe('https://www.linkedin.com/jobs/view/1/?a=1&b=2');
    expect(safeHttpUrl('https://example.com/a b"c')).toBe('https://example.com/a%20b%22c');
    for (const u of ['javascript:alert(1)', 'file:///C:/Windows/system32/calc.exe', 'ms-settings:', 'not a url']) expect(() => safeHttpUrl(u)).toThrow();
  });
});

describe('"Apply on company website" links', () => {
  const setup = () => {
    const db = openDb(':memory:');
    importAlertEmails(db, [{ messageId: '<a@x>', date: null, html: fx('linkedin-alert-cards.html'), text: null }]);
    const repo = new Repo(db);
    return { db, repo, job: repo.listJobs({ site: 'linkedin', q: 'Acme' }).items[0]! };
  };

  it('a Drushim job link becomes a normal Drushim job (automated flow); the LinkedIn job points to it', () => {
    expect(supportedSiteJob('https://www.drushim.co.il/job/34567890/abc123/?utm=x')).toEqual({ site: 'drushim', externalId: '34567890', url: 'https://www.drushim.co.il/job/34567890/abc123/' });
    const { db, repo, job } = setup();
    const r = routeExternalApply(db, job, 'https://www.drushim.co.il/job/34567890/abc123/');
    expect(r).toMatchObject({ kind: 'site', site: 'drushim', created: true });
    const d = repo.getJob((r as { jobId: string }).jobId)!;
    expect(d).toMatchObject({ site: 'drushim', externalId: '34567890', prefilterPass: true, detailsFetched: false, status: 'discovered' });
    expect(repo.jobsNeedingDetails('drushim').map((j) => j.id)).toContain(d.id);
    expect(repo.getJob(job.id)).toMatchObject({ status: 'skipped', duplicateOf: d.id });
  });

  it('any other link goes to the review queue as an external application', () => {
    const { db, repo, job } = setup();
    expect(routeExternalApply(db, job, 'https://careers.acme.example/jobs/77')).toEqual({ kind: 'manual', url: 'https://careers.acme.example/jobs/77' });
    expect(repo.getJob(job.id)).toMatchObject({ applyType: 'external', applyTarget: 'https://careers.acme.example/jobs/77' });
    expect(() => routeExternalApply(db, job, 'https://www.linkedin.com/jobs/view/1/')).toThrow(/LinkedIn link/);
  });
});
