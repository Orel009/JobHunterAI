/**
 * The job ad for an application page that does not show it (JobHunter Fill): Workable's job endpoint (the overview page is
 * a script shell), Greenhouse's and SmartRecruiters' job endpoints, Comeet's page token + positions (two requests), and
 * for any other site the same address without "/apply" (same origin). LinkedIn / Indeed are never fetched; an answer is
 * kept for an hour; a failure is a reason, never an exception.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-job-context';
  process.env.PREFERENCES_FILE = 'data/test-job-context/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
});

import fs from 'node:fs';
import { fetchJobContext, pageMainText } from '../src/extension/job-context.js';
import { buildApp } from '../src/server/app.js';
import { openDb } from '../src/db/index.js';
import { extensionToken } from '../src/extension/token.js';

const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const WK = JSON.parse(fx('workable-job.json'));
const SR1 = JSON.parse(fx('smartrecruiters-posting.json'));
const COMEET_PAGE = fx('comeet-page.html');
const POSITIONS = JSON.parse(fx('comeet-positions.json')) as Array<{ uid: string }>;

function fake(routes: Array<[RegExp, (u: string) => { status?: number; body: unknown }]>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response('not found', { status: 404 });
    const { status = 200, body } = hit[1](url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('the job ad behind an application page', () => {
  it('Workable: the public job endpoint (description + requirements as text), never the overview page', async () => {
    const { f, calls } = fake([[/apply\.workable\.com\/api\/v2\/accounts\/goarc\/jobs\/30E379F87B$/, () => ({ body: WK })]]);
    const r = await fetchJobContext('https://apply.workable.com/goarc/j/30E379F87B/apply/', f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context).toMatchObject({ title: 'Full Stack Developer', source: "Workable's job API" });
    expect(r.context.text).toMatch(/6\+ years of experience developing modern web applications/);
    expect(r.context.text).not.toMatch(/<h3>|<li>/);
    expect(calls).toHaveLength(1);
    // kept for an hour: the same page again is not fetched
    await fetchJobContext('https://apply.workable.com/goarc/j/30E379F87B/apply/', f);
    expect(calls).toHaveLength(1);
  });

  it('SmartRecruiters: the posting endpoint; the "Easy apply" page (a uuid only) has no endpoint → the reason', async () => {
    const { f } = fake([[/api\.smartrecruiters\.com\/v1\/companies\/Wix2\/postings\/744000158971809$/, () => ({ body: SR1 })]]);
    const r = await fetchJobContext('https://jobs.smartrecruiters.com/Wix2/744000158971809-technical-support-team-lead', f);
    expect(r).toMatchObject({ ok: true, context: { source: "SmartRecruiters' posting API", company: 'Wix' } });
    if (r.ok) expect(r.context.text).toMatch(/2\+ years leading technical support/);
    const e = await fetchJobContext('https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2/publication/8563a7fa-d926-41a8-9ece-49e1501d03bf', f);
    expect(e.ok).toBe(false);
  });

  it('Greenhouse: the job endpoint by board and id', async () => {
    const { f, calls } = fake([[/boards-api\.greenhouse\.io\/v1\/boards\/similarweb\/jobs\/7972320$/, () => ({ body: { title: 'Big Data Engineer', content: '&lt;p&gt;Build data pipelines with Spark.&lt;/p&gt;'.repeat(12), company_name: 'Similarweb' } })]]);
    const r = await fetchJobContext('https://job-boards.greenhouse.io/similarweb/jobs/7972320?gh_src=x', f);
    expect(r).toMatchObject({ ok: true, context: { title: 'Big Data Engineer', company: 'Similarweb', source: "Greenhouse's job API" } });
    expect(calls).toHaveLength(1);
  });

  it('Comeet (the job page, or the apply frame by its company / position uids): the public page for the token, then the positions', async () => {
    const pos = POSITIONS[0]!;
    const { f, calls } = fake([
      [/comeet\.com\/jobs\//, () => ({ body: COMEET_PAGE })],
      [/careers-api\/2\.0\/company\/17\.008\/positions/, () => ({ body: POSITIONS })],
    ]);
    const r = await fetchJobContext(`https://www.comeet.co/jobs/17.008/${pos.uid}/apply?company-name=cyera&company-uid=17.008&position-uid=${pos.uid}&embedded=true&referrer=https%3A%2F%2Fwww.linkedin.com%2F`, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.source).toBe("Comeet's positions API");
    expect(calls.map((u) => (/careers-api/.test(u) ? 'positions' : 'page'))).toEqual(['page', 'positions']);
  });

  it('any other site: the same address without "/apply", its main text (no navigation / footer); nothing there → the reason', async () => {
    const page = `<html><body><nav>Home Careers Blog</nav><main><h1>Backend Engineer</h1><p>${'Build payment APIs in Node.js. '.repeat(15)}</p></main><footer>Privacy</footer></body></html>`;
    const { f, calls } = fake([[/^https:\/\/careers\.example\.test\/jobs\/42\/$/, () => ({ body: page })]]);
    const r = await fetchJobContext('https://careers.example.test/jobs/42/apply', f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.text).toMatch(/Build payment APIs/);
      expect(r.context.text).not.toMatch(/Home Careers Blog|Privacy/);
      expect(r.context.source).toBe('the page /jobs/42/');
    }
    expect(calls).toEqual(['https://careers.example.test/jobs/42/']);
    const shell = fake([[/./, () => ({ body: '<html><body><div id="root"></div></body></html>' })]]);
    expect(await fetchJobContext('https://other.example.test/p/1/apply', shell.f)).toMatchObject({ ok: false, error: expect.stringMatching(/no job ad found at https:\/\/other\.example\.test\/p\/1\/ either/) });
    expect(await fetchJobContext('https://other.example.test/p/1', shell.f)).toMatchObject({ ok: false, error: expect.stringMatching(/no "\/apply" to go back from/) });
  });

  it('LinkedIn / Indeed: never fetched', async () => {
    const { f, calls } = fake([[/./, () => ({ body: '<html>x</html>' })]]);
    for (const u of ['https://www.linkedin.com/jobs/view/4012345678/apply', 'https://il.indeed.com/viewjob?jk=a1b2c3d4e5f60718']) expect((await fetchJobContext(u, f)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('pageMainText keeps the main content only', () => {
    expect(pageMainText('<html><head><script>x()</script></head><body><header>Logo</header><main><p>Hello world</p></main><form><input></form><footer>Terms</footer></body></html>')).toBe('Hello world');
  });

  it('the route: for the extension only (the token), the context or the reason', async () => {
    const app = buildApp(openDb(':memory:'));
    expect((await app.inject({ method: 'POST', url: '/api/fill/job-context', payload: { url: 'https://x.test/' } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/fill/job-context', headers: { 'x-jobhunter-token': extensionToken() }, payload: { url: 'https://www.linkedin.com/jobs/view/1/apply' } });
    expect(r.json()).toMatchObject({ ok: false, error: expect.stringMatching(/never fetched/) });
  });
});
