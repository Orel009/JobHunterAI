/**
 * A paused / disabled site is never loaded: no session check (Drushim's or any site's), no fetch of its job pages —
 * only its one resume check may load it. Drushim's session check tells bot protection (Radware's
 * validate.perfdrive.com) from "logged out" and pauses the site instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-paused-load';
  process.env.PREFERENCES_FILE = 'data/test-paused-load/preferences.yaml';
  return { contexts: 0, loads: [] as string[], challenge: false };
});

/** a stand-in page: the Drushim homepage, its session probe (200), and — when h.challenge — a request to Radware's challenge host */
const fakePage = () => {
  const on: Record<string, Array<(x: unknown) => void>> = {};
  const emit = (e: string, x: unknown) => (on[e] ?? []).forEach((f) => f(x));
  return {
    on: (e: string, f: (x: unknown) => void) => void (on[e] ??= []).push(f),
    off: () => undefined,
    waitForTimeout: async () => undefined,
    goto: async (url: string) => {
      h.loads.push(url);
      if (h.challenge) emit('request', { url: () => 'https://validate.perfdrive.com/drushim/captcha?ssa=1' });
      emit('response', { url: () => 'https://gw.drushim.co.il/auth/seeker-details', status: () => 200 });
      return { status: () => 200 };
    },
    title: async () => 'דרושים',
    evaluate: async () => false,
    content: async () => '',
  };
};
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getContext: async () => (h.contexts++, { cookies: async () => [] }) as never,
  getPage: async () => fakePage() as never,
  closeContext: async () => undefined,
}));

import { checkDrushimSession, checkSiteSession, isChallengeUrl, resumeSessionCheck } from '../src/browser/site-session.js';
import { clearResume, pauseOf, pauseSite, setManualOnly, sitePauses, unpauseSite } from '../src/core/site-pause.js';
import { fetchJobContext } from '../src/extension/job-context.js';
import { sessionReport } from '../src/browser/session-report.js';

beforeEach(() => {
  for (const s of Object.keys(sitePauses())) unpauseSite(s);
  for (const s of ['drushim', 'jobkarov']) clearResume(s);
  h.contexts = 0;
  h.loads = [];
  h.challenge = false;
});

describe('a paused site is not loaded', () => {
  it('Drushim paused: its session check (the one npm start ran) loads nothing and says "paused until …"', async () => {
    pauseSite('drushim', 'captcha', { now: new Date() });
    const r = await checkDrushimSession();
    expect(r).toMatchObject({ state: 'unknown', paused: true, detail: expect.stringMatching(/^Drushim is paused: CAPTCHA \/ bot check \(until \w{3} \d\d\.\d\d \d\d:\d\d Israel time/) });
    expect(r.detail).toMatch(/not loaded/);
    expect(h.contexts).toBe(0);
    expect(h.loads).toEqual([]);
  });
  it('any site: checkSiteSession and the session report load nothing while paused or disabled', async () => {
    pauseSite('drushim', 'captcha');
    setManualOnly('jobkarov', 'refuses this browser');
    expect(await checkSiteSession('drushim')).toMatchObject({ paused: true });
    expect(await checkSiteSession('jobkarov')).toMatchObject({ paused: true, detail: expect.stringMatching(/^JobKarov is disabled/) });
    expect((await sessionReport('data/test-paused-load/no-profile', 'drushim')).session).toMatchObject({ paused: true });
    expect(h.contexts).toBe(0);
  });
  it('the resume check is the one exception (it loads the site once)', async () => {
    pauseSite('drushim', 'captcha', { now: new Date(Date.now() - 49 * 3_600_000) });
    const r = await resumeSessionCheck('drushim');
    expect(h.loads).toEqual(['https://www.drushim.co.il']);
    expect(r).toMatchObject({ state: 'logged_in', realPage: true });
  });
  it('the extension never fetches a paused site\'s job page (other sites still are)', async () => {
    pauseSite('drushim', 'captcha');
    const fetched: string[] = [];
    const f = (async (u: string) => (fetched.push(String(u)), new Response('<html><body>' + 'x'.repeat(500) + '</body></html>', { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchJobContext('https://www.drushim.co.il/job/35000017/abc/apply', f)).toMatchObject({ ok: false, error: expect.stringMatching(/^Drushim is paused.*not fetched while paused/) });
    expect(fetched).toEqual([]);
    await fetchJobContext('https://careers.example.com/jobs/1/apply', f);
    expect(fetched).toEqual(['https://careers.example.com/jobs/1/']);
  });
});

describe('Drushim\'s session check and bot protection', () => {
  it('validate.perfdrive.com is Radware\'s challenge host; its other hosts are not', () => {
    expect(isChallengeUrl('https://validate.perfdrive.com/abc/captcha?ssa=1')).toBe(true);
    expect(isChallengeUrl('https://cdn.perfdrive.com/aperture/aperture.js')).toBe(false);
    expect(isChallengeUrl('https://www.drushim.co.il/')).toBe(false);
  });
  it('a challenge during the check → blocked (never "logged in / out"), and Drushim pauses', async () => {
    h.challenge = true;
    const r = await checkDrushimSession();
    expect(r).toMatchObject({ state: 'unknown', blocked: 'radware bot protection (validate.perfdrive.com)', realPage: false });
    expect(pauseOf('drushim')).toMatchObject({ reason: 'bot protection', source: 'block' });
  });
  it('no challenge → the probe decides, as before', async () => {
    expect(await checkDrushimSession()).toMatchObject({ state: 'logged_in', detail: 'probe 200' });
    expect(pauseOf('drushim')).toBeNull();
  });
});
