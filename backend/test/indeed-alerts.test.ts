/**
 * Indeed via email (assisted-only, like LinkedIn): the alert parser, offline link resolution (Indeed is never
 * requested), routing by destination, cross-source dedupe, per-source settings, and the hard rule (no automation).
 * Sample emails are sanitized (fictional companies, job keys and tokens). Own data folder; nothing touches IMAP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-indeed';
  process.env.PREFERENCES_FILE = 'data/test-indeed/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { config } from '../src/config.js';
import { openDb, type DB } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob, jobId } from '../src/core/job.js';
import { isIndeedAlertSender, parseIndeedAlert, parseIndeedHtml, parseIndeedText, resolveAlertLink } from '../src/alerts/indeed.js';
import { isAssistedOnlyHost, isIndeedHost } from '../src/alerts/assisted.js';
import { importAlertEmails } from '../src/alerts/importer.js';
import { ALERT_SOURCES } from '../src/linkedin/imap.js';
import { emailAlertSettings, enabledSources, saveEmailAlertSettings } from '../src/linkedin/settings.js';
import { readSettingsFile, writeSettingsFile } from '../src/llm/settings.js';
import { Applications } from '../src/apply/plan.js';
import { prepareJobs, queueExternalForReview } from '../src/apply/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => fs.readFileSync(path.join(here, 'fixtures', f), 'utf8');
const b64url = (o: unknown) => gzipSync(Buffer.from(JSON.stringify(o))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('Indeed alert parsing', () => {
  const jobs = parseIndeedHtml(fx('indeed-alert.html'));

  it('reads every card once: title, company, location, salary, "Easily apply", and where applying happens', () => {
    expect(jobs.map((j) => [j.title, j.company, j.location, j.link.kind, j.indeedApply])).toEqual([
      ['מפתח/ת Full Stack', 'אקמה תוכנה בע"מ', 'תל אביב-יפו', 'indeed', true],
      ['Full Stack Developer', 'ExampleCorp', 'Herzliya, Center District', 'company', false],
      ['מפתח/ת Backend', 'גלובקס מערכות', 'פתח תקווה', 'drushim', false],
      ['Senior Software Engineer', 'Initech', 'Tel Aviv-Yafo', 'indeed', false],
      ['QA Automation Engineer', 'Umbrella Ltd', 'Netanya', 'indeed', true],
    ]);
    expect(jobs[1]!.salaryText).toBe('₪20,000 - ₪26,000 a month');
    expect(jobs[0]!.externalId).toBe('0a1b2c3d4e5f6a7b');
    expect(jobs[0]!.indeedUrl).toBe('https://il.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b');
  });

  it('the ATS and Drushim destinations are read from inside the links; the Indeed link is kept for the source', () => {
    expect(jobs[1]!.link.url).toBe('https://boards.greenhouse.io/examplecorp/jobs/4455667?gh_src=indeed_alert');
    expect(jobs[1]!.indeedUrl).toMatch(/^https:\/\/cts\.indeed\.com\/v3\//);
    expect(jobs[2]!.link.url).toMatch(/^https:\/\/www\.drushim\.co\.il\/job\/33445566\//);
    expect(jobs[2]!.indeedUrl).toBe('https://il.indeed.com/viewjob?jk=1111222233334444');
    expect(jobs[3]!.indeedUrl).toBe('https://il.indeed.com/viewjob?jk=3c4d5e6f70819203');
  });

  it('footer links (view all, manage, unsubscribe, privacy) are never jobs', () => {
    expect(jobs.map((j) => j.title).join('|')).not.toMatch(/View all|Manage|Unsubscribe|Privacy/);
  });

  it('falls back to the text part when the HTML has no cards', () => {
    const t = parseIndeedText(fx('indeed-alert.txt'));
    expect(t.map((j) => [j.title, j.company, j.location, j.link.kind, j.indeedApply])).toEqual([
      ['מפתח/ת Full Stack', 'אקמה תוכנה בע"מ', 'תל אביב-יפו', 'indeed', true],
      ['Full Stack Developer', 'ExampleCorp', 'Herzliya, Center District', 'company', false],
    ]);
    expect(parseIndeedAlert({ html: '<p>no cards</p>', text: fx('indeed-alert.txt') })).toHaveLength(2);
  });

  it('only Indeed alert senders are read', () => {
    for (const a of ['alert@indeed.com', 'Alert@Indeed.com', 'jobalerts-noreply@indeed.com', 'x@jobalert.indeed.com', 'noreply@match.indeed.com']) expect(isIndeedAlertSender(a)).toBe(true);
    for (const a of ['recruiter@indeed.com.evil.example', 'alert@notindeed.com', 'hr@company.co.il', undefined]) expect(isIndeedAlertSender(a)).toBe(false);
    expect(ALERT_SOURCES.indeed.isSender('alert@indeed.com')).toBe(true);
    expect(ALERT_SOURCES.linkedin.isSender('alert@indeed.com')).toBe(false);
  });
});

describe('link resolution is offline (Indeed is never requested)', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  afterEach(() => expect(fetchSpy).not.toHaveBeenCalled());

  it('unwraps email click-trackers and safe links', () => {
    const ats = 'https://jobs.lever.co/example/abc-123';
    expect(resolveAlertLink(`https://www.google.com/url?q=${encodeURIComponent(ats)}&sa=D`)).toMatchObject({ kind: 'company', url: ats });
    expect(resolveAlertLink(`https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(ats)}&data=x`)).toMatchObject({ kind: 'company', url: ats });
  });

  it("decodes Indeed's encoded tracking payload", () => {
    expect(resolveAlertLink(`https://cts.indeed.com/v3/${b64url({ u: 'https://careers.example.co.il/jobs/9' })}`)).toMatchObject({ kind: 'company', url: 'https://careers.example.co.il/jobs/9' });
    expect(resolveAlertLink(`https://cts.indeed.com/v3/${b64url({ u: 'https://il.indeed.com/rc/clk/dl?jk=abcdefabcdefabcd' })}`)).toEqual({
      kind: 'indeed', url: 'https://il.indeed.com/viewjob?jk=abcdefabcdefabcd', jk: 'abcdefabcdefabcd', indeedUrl: 'https://il.indeed.com/viewjob?jk=abcdefabcdefabcd',
    });
  });

  it('a destination only Indeed knows → the Indeed link is kept', () => {
    expect(resolveAlertLink('https://il.indeed.com/rc/clk/dl?jk=00112233aabbccdd&from=ja')).toMatchObject({ kind: 'indeed', url: 'https://il.indeed.com/viewjob?jk=00112233aabbccdd' });
    const opaque = 'https://il.indeed.com/pagead/clk/dl?mo=r&ad=-6NYopaque';
    expect(resolveAlertLink(opaque)).toMatchObject({ kind: 'indeed', url: opaque, jk: null });
  });

  it('a Drushim job link is recognised', () => {
    expect(resolveAlertLink('https://il.indeed.com/pagead/clk/dl?jk=1111222233334444&adurl=https%3A%2F%2Fwww.drushim.co.il%2Fjob%2F1%2Fx%2F')).toMatchObject({ kind: 'drushim', jk: '1111222233334444' });
  });
});

describe('Indeed is never automated', () => {
  it('the automated browser blocks indeed.com and its subdomains (like LinkedIn)', () => {
    const session = fs.readFileSync(path.join(here, '..', 'src', 'browser', 'session.ts'), 'utf8');
    expect(session).toMatch(/ctx\.route\(\(u\) => isAssistedOnlyHost\(u\.href\), \(route\) => route\.abort/);
    for (const u of ['https://il.indeed.com/viewjob?jk=1', 'https://www.indeed.com/', 'https://cts.indeed.com/v3/x', 'https://apply.indeed.com/a', 'https://indeed.com', 'https://uk.indeed.co.uk/']) {
      expect(isIndeedHost(u)).toBe(true);
      expect(isAssistedOnlyHost(u)).toBe(true);
    }
    for (const u of ['https://indeed.com.evil.example/', 'https://notindeed.com/', 'https://www.drushim.co.il/', 'not a url']) expect(isIndeedHost(u)).toBe(false);
  });

  it('src/alerts/** never imports Playwright, the browser session or a site adapter (transitively)', () => {
    const src = path.join(here, '..', 'src');
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string, from: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = path.relative(src, file).replace(/\\/g, '/');
      if (/^browser\//.test(rel) || /^sites\/[^/]+\/(adapter|apply)\.ts$/.test(rel) || /^pipeline\//.test(rel)) {
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
    for (const f of fs.readdirSync(path.join(src, 'alerts')).filter((x) => x.endsWith('.ts'))) visit(path.join(src, 'alerts', f), `alerts/${f}`);
    expect(seen.size).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});

// ---------- import + routing ----------
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, 'cv: { he: cv.pdf, en: cv.pdf }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [x], titleKeywords: [full stack, backend, software engineer, qa automation] }\n');

let db: DB;
let repo: Repo;
const indeedMail = (id = '<indeed-1@sample>') => ({ messageId: id, date: new Date().toISOString(), html: fx('indeed-alert.html'), text: null, source: 'indeed' as const });
const ij = (jk: string) => repo.getJob(jobId('indeed', jk))!;
beforeEach(() => {
  db = openDb(':memory:');
  repo = new Repo(db);
});

describe('Indeed import: routing by destination', () => {
  it('Indeed Apply / unknown → assisted; company / ATS → the link; Drushim → a normal Drushim job', () => {
    const st = importAlertEmails(db, [indeedMail()]);
    expect(st).toMatchObject({ emails: 1, jobsFound: 5, inserted: 5, toDrushim: 1, toCompany: 1, assisted: 3 });
    // assisted: open in your own browser, nothing filled in automatically
    expect(ij('0a1b2c3d4e5f6a7b')).toMatchObject({ site: 'indeed', applyType: 'external', applyTarget: '', url: 'https://il.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b' });
    // company / ATS link: an external application with that link
    const ats = repo.listJobs({ site: 'indeed', q: 'ExampleCorp' }).items[0]!;
    expect(ats).toMatchObject({ applyType: 'external', applyTarget: 'https://boards.greenhouse.io/examplecorp/jobs/4455667?gh_src=indeed_alert' });
    // Drushim: a Drushim job for the automated flow; the Indeed copy points to it and its link is kept
    const drushim = repo.getJob(jobId('drushim', '33445566'))!;
    expect(drushim).toMatchObject({ site: 'drushim', applyType: 'site_one_click', url: 'https://www.drushim.co.il/job/33445566/a1b2c3d4/', duplicateOf: null });
    expect(st.drushimJobsCreated).toEqual([drushim.id]);
    expect(ij('1111222233334444')).toMatchObject({ duplicateOf: drushim.id, status: 'skipped_duplicate' });
    expect(repo.sourceLinks(drushim.id).map((l) => l.site)).toEqual(['drushim', 'indeed']);
  });

  it('each email is imported once; a known job keeps what the user added', () => {
    importAlertEmails(db, [indeedMail()]);
    db.prepare("UPDATE jobs SET description_text = 'pasted by me' WHERE id = ?").run(jobId('indeed', '0a1b2c3d4e5f6a7b'));
    expect(importAlertEmails(db, [indeedMail()])).toMatchObject({ skippedEmails: 1, inserted: 0 });
    expect(importAlertEmails(db, [indeedMail('<indeed-2@sample>')])).toMatchObject({ emails: 1, inserted: 0, known: 5 });
    expect(ij('0a1b2c3d4e5f6a7b').descriptionText).toBe('pasted by me');
  });

  it('a Drushim job already known is not created again (dedupe against existing jobs)', () => {
    const d = toJob({ site: 'drushim', externalId: '33445566', company: 'גלובקס מערכות', title: 'מפתח/ת Backend', location: 'פתח תקווה', descriptionText: 'x', requirementsText: '', url: 'https://www.drushim.co.il/job/33445566/a1b2c3d4/', postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'he', detailsFetched: true, raw: {} });
    repo.upsertJob(d);
    const st = importAlertEmails(db, [indeedMail()]);
    expect(st.drushimJobsCreated).toEqual([]);
    expect(ij('1111222233334444').duplicateOf).toBe(d.id);
    expect(repo.getJob(d.id)!.descriptionText).toBe('x');
  });

  it('scored ATS jobs go to the review queue with the link; assisted Indeed jobs cannot enter the automated flow', () => {
    importAlertEmails(db, [indeedMail()]);
    const ats = repo.listJobs({ site: 'indeed', q: 'ExampleCorp' }).items[0]!;
    for (const j of repo.listJobs({ site: 'indeed', limit: 50 }).items.filter((x) => !x.duplicateOf)) {
      repo.setPrefilter(j.id, true, 'ok');
      repo.saveScore(j.id, { score: 90, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'fullstack' });
    }
    expect(queueExternalForReview(db, 'indeed', 70)).toBe(1);
    expect(new Applications(db).latestForJob(ats.id)).toMatchObject({ status: 'needs_review', plan: { notes: [expect.stringContaining('greenhouse.io/examplecorp')] } });
    expect(queueExternalForReview(db, 'indeed', 70)).toBe(0); // once
    expect(() => prepareJobs(db, [jobId('indeed', '0a1b2c3d4e5f6a7b')])).toThrow(/applied to by hand/);
  });
});

describe('cross-source dedupe (same company + title within 14 days = one job, every link kept)', () => {
  const linkedinMail = {
    messageId: '<li-1@sample>',
    date: new Date().toISOString(),
    html: '<table><tr><td><a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trk=x">Senior Software Engineer</a></td></tr><tr><td>Initech · Tel Aviv-Yafo</td></tr></table>',
    text: null,
  };

  it('LinkedIn first, then the same job from Indeed → one job with both links', () => {
    importAlertEmails(db, [linkedinMail]);
    const st = importAlertEmails(db, [indeedMail()]);
    const li = repo.getJob(jobId('linkedin', '4012345678'))!;
    expect(st.duplicates).toBeGreaterThanOrEqual(2); // Initech (→ LinkedIn) and the Drushim-linked card
    expect(ij('3c4d5e6f70819203').duplicateOf).toBe(li.id);
    expect(repo.sourceLinks(li.id).map((l) => [l.site, l.url])).toEqual([
      ['linkedin', 'https://www.linkedin.com/jobs/view/4012345678/'],
      ['indeed', 'https://il.indeed.com/viewjob?jk=3c4d5e6f70819203'],
    ]);
  });

  it('a later Drushim copy of an untouched alert job becomes the one job (it can be applied to automatically)', () => {
    importAlertEmails(db, [linkedinMail, indeedMail()]);
    const li = repo.getJob(jobId('linkedin', '4012345678'))!;
    const d = toJob({ site: 'drushim', externalId: '999', company: 'Initech', title: 'Senior Software Engineer', location: 'תל אביב', descriptionText: 'x', requirementsText: '', url: 'https://www.drushim.co.il/job/999/x/', postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
    repo.upsertJob(d);
    expect(repo.dedupeNewJob(d, config.DEDUPE_WINDOW_DAYS)).toEqual({ duplicateOf: null, absorbed: li.id });
    expect(repo.sourceLinks(d.id).map((l) => l.site).sort()).toEqual(['drushim', 'indeed', 'linkedin']);
    expect(repo.getJob(li.id)).toMatchObject({ duplicateOf: d.id, status: 'skipped_duplicate' });
  });

  it('an alert job you already applied to by hand stays the one job', () => {
    importAlertEmails(db, [linkedinMail]);
    const li = repo.getJob(jobId('linkedin', '4012345678'))!;
    db.prepare("UPDATE jobs SET status = 'submitted_manual' WHERE id = ?").run(li.id);
    const d = toJob({ site: 'drushim', externalId: '998', company: 'Initech', title: 'Senior Software Engineer', location: '', descriptionText: 'x', requirementsText: '', url: 'https://www.drushim.co.il/job/998/x/', postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
    repo.upsertJob(d);
    expect(repo.dedupeNewJob(d, config.DEDUPE_WINDOW_DAYS)).toEqual({ duplicateOf: li.id, absorbed: null });
  });

  it('more than 14 days apart → two jobs', () => {
    importAlertEmails(db, [linkedinMail]);
    db.prepare("UPDATE jobs SET first_seen_at = ? WHERE site = 'linkedin'").run(new Date(Date.now() - 20 * 86_400_000).toISOString());
    importAlertEmails(db, [indeedMail()]);
    expect(ij('3c4d5e6f70819203').duplicateOf).toBeNull();
    expect(config.DEDUPE_WINDOW_DAYS).toBe(14);
  });
});

describe('Email job alerts settings: one switch, each source separately', () => {
  it('the older LinkedIn-only setting carries over; Indeed starts off', () => {
    const file = readSettingsFile();
    const { emailAlerts: _e, ...rest } = file as unknown as Record<string, unknown>;
    writeSettingsFile({ ...rest, linkedinAlerts: { enabled: true, windowDays: 7, mailbox: 'Jobs' } } as unknown as typeof file);
    expect(emailAlertSettings()).toEqual({ enabled: true, sources: { linkedin: true, indeed: false }, windowDays: 7, mailbox: 'Jobs' });
    expect(enabledSources()).toEqual(['linkedin']);
  });

  it('Indeed can be turned on alone; the feature switch turns everything off', () => {
    saveEmailAlertSettings({ enabled: true, sources: { linkedin: false, indeed: true } });
    expect(enabledSources()).toEqual(['indeed']);
    expect((readSettingsFile() as unknown as Record<string, unknown>).linkedinAlerts).toBeUndefined();
    saveEmailAlertSettings({ enabled: false });
    expect(enabledSources()).toEqual([]);
    expect(emailAlertSettings().sources).toEqual({ linkedin: false, indeed: true });
  });
});
