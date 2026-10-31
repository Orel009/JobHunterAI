/**
 * Scheduling (pure rules, the Task Scheduler XML, the toast text) and the hunt summary, including an expired
 * Drushim login (discovery-only). Stand-in site and browser; own data folder and preferences; test-mode model.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-hunt';
  process.env.PREFERENCES_FILE = 'data/test-hunt/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { panels: 0, toasts: [] as string[] };
});
vi.mock('../src/browser/session.js', async (orig) => ({
  ...(await orig<typeof import('../src/browser/session.js')>()),
  getPage: async () => ({}) as never,
  closeContext: async () => undefined,
  pace: async () => undefined,
}));
vi.mock('../src/sites/drushim/apply.js', async (orig) => ({
  ...(await orig<typeof import('../src/sites/drushim/apply.js')>()),
  fetchAppliedJobs: async () => new Map(),
  installDryRunGuard: async () => async () => undefined,
  openPanel: async () => {
    h.panels++;
    return { fields: [], cvs: [{ code: '4', name: 'cv.pdf', checked: true }], hasCoverLetter: false };
  },
  fillPanel: async () => undefined,
  screenshotPanel: async () => 'shot.png',
}));
vi.mock('../src/sites/registry.js', async (orig) => {
  const real = await orig<typeof import('../src/sites/registry.js')>();
  let n = 0;
  const fake = {
    id: 'drushim' as const,
    displayName: 'Drushim',
    loginUrl: 'https://www.drushim.co.il/',
    async *search() {
      n++;
      for (const [id, title] of [[`${n}01`, 'Full Stack Developer'], [`${n}02`, 'Senior Full Stack Developer']] as const) {
        yield {
          site: 'drushim' as const, externalId: id, company: `Co ${id}`, title, location: '', descriptionText: 'React', requirementsText: '',
          url: `https://www.drushim.co.il/job/${id}/x/`, postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {},
        };
      }
    },
    async getDetails() {
      return null;
    },
  };
  return { ...real, adapters: { drushim: fake }, getAdapter: (id: string) => (id === 'drushim' ? fake : real.getAdapter(id)) };
});

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { profilePath } from '../src/profile/facts.js';
import { DEFAULT_SCHEDULE, dueSlot, inQuietHours, nextRun, runnableTimes } from '../src/pipeline/schedule.js';
import { doneReport, huntProgress, recentHunts, runHunt, skipReason } from '../src/pipeline/hunt.js';
import { toastScript } from '../src/notify/toast.js';
// @ts-expect-error — plain .mjs script without type declarations
import { buildTaskXml } from '../../scripts/schedule.mjs';

// local times (the scheduler works in the computer's time zone)
const at = (y: number, m: number, d: number, hh: number, mm: number) => new Date(y, m - 1, d, hh, mm);
// 2026-11-01 is a Sunday; 2026-11-06 a Friday
const SUN = (hh: number, mm: number) => at(2026, 11, 1, hh, mm);

describe('schedule rules', () => {
  it('quiet hours, including past midnight', () => {
    const q = { from: '22:00', to: '07:00' };
    expect(['22:00', '23:59', '00:30', '06:59'].map((t) => inQuietHours(t, q))).toEqual([true, true, true, true]);
    expect(['07:00', '09:15', '21:59'].map((t) => inQuietHours(t, q))).toEqual([false, false, false]);
    expect(inQuietHours('12:00', { from: '12:00', to: '13:00' })).toBe(true);
    expect(runnableTimes({ ...DEFAULT_SCHEDULE, times: ['06:30', '09:15', '23:00'] })).toEqual(['09:15']);
  });

  it('a slot is due at its time (up to 10 minutes late), on scheduled days, once per day', () => {
    const s = { ...DEFAULT_SCHEDULE, enabled: true };
    expect(dueSlot(SUN(9, 15), s, new Set())).toBe('2026-11-01 09:15');
    expect(dueSlot(SUN(9, 25), s, new Set())).toBe('2026-11-01 09:15');
    expect(dueSlot(SUN(9, 26), s, new Set())).toBeNull();
    expect(dueSlot(SUN(9, 14), s, new Set())).toBeNull();
    expect(dueSlot(SUN(9, 16), s, new Set(['2026-11-01 09:15']))).toBeNull();
    expect(dueSlot(SUN(16, 15), s, new Set(['2026-11-01 09:15']))).toBe('2026-11-01 16:15');
    expect(dueSlot(at(2026, 11, 6, 9, 15), s, new Set())).toBeNull(); // Friday
  });

  it('never inside quiet hours, even when a time is set there', () => {
    const s = { ...DEFAULT_SCHEDULE, times: ['23:30'], quietHours: { from: '22:00', to: '07:00' } };
    expect(dueSlot(SUN(23, 30), s, new Set())).toBeNull();
    expect(nextRun(SUN(12, 0), s)).toBeNull();
  });

  it('next run: Thursday evening → Sunday 09:15', () => {
    expect(nextRun(at(2026, 11, 5, 17, 0), DEFAULT_SCHEDULE)).toEqual(at(2026, 11, 8, 9, 15));
    expect(nextRun(SUN(10, 0), DEFAULT_SCHEDULE)).toEqual(SUN(16, 15));
  });
});

describe('Windows Task Scheduler task', () => {
  it('one weekly trigger per runnable time, Sunday–Thursday, only while logged in, the hunt command', () => {
    const xml: string = buildTaskXml({ ...DEFAULT_SCHEDULE, times: ['09:15', '16:15', '23:00'], user: 'PC\\dana', root: 'C:\\Users\\dana\\R&D\\JobHunterAI', startDate: '2026-11-01' });
    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(2); // 23:00 is in quiet hours
    expect(xml).toContain('<StartBoundary>2026-11-01T09:15:00</StartBoundary>');
    expect(xml).toContain('<StartBoundary>2026-11-01T16:15:00</StartBoundary>');
    expect(xml).toContain('<DaysOfWeek><Sunday /><Monday /><Tuesday /><Wednesday /><Thursday /></DaysOfWeek>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>'); // never "run whether logged on or not"
    expect(xml).toContain('<Arguments>/c npm start -- --hunt --no-browser</Arguments>');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\dana\\R&amp;D\\JobHunterAI</WorkingDirectory>');
    expect(xml).toContain('<StartWhenAvailable>false</StartWhenAvailable>');
  });
});

describe('toast', () => {
  it('text is quoted, never code', () => {
    const s = toastScript("Hunt's done", "found 3 <jobs> & it's ok'; Remove-Item C:\\x; '\nline2");
    expect(s).toContain("Hunt''s done");
    expect(s).toContain('&lt;jobs&gt; &amp;');
    expect(s).toContain("it''s ok''; Remove-Item C:\\x; ''");
    expect(s).not.toContain('\n');
  });
});

describe('hunt summary', () => {
  fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
  fs.writeFileSync(profilePath(), JSON.stringify({ contact: { name: { he: 'דנה', en: 'Dana Test' }, city: {} }, skills: [{ id: 'skill.react', name: 'React' }] }));
  fs.writeFileSync(
    config.paths.preferences,
    'cv: { he: cv.pdf, en: cv.pdf }\nthresholds: { autoSubmitMinScore: 0 }\nfilters: { excludeSeniorityKeywords: [Senior] }\nroleTypes:\n  - { id: fullstack, tier: 1, queries: [Full Stack], titleKeywords: [full stack] }\n',
  );

  it('reasons are grouped for the summary', () => {
    expect(skipReason('skipped', 'prefilter: seniority: "Senior"')).toBe('prefilter: seniority');
    expect(skipReason('skipped', 'already_applied: on drushim (sent 2026-10-28)')).toBe('already_applied');
    expect(skipReason('skipped', 'duplicate of abc')).toBe('duplicate');
    expect(skipReason('skipped_experience', 'requires 5y')).toBe('skipped_experience');
  });

  it('Drushim login expired → discovery-only, and the summary says to log in again', async () => {
    const db = openDb(':memory:');
    h.panels = 0;
    h.toasts = [];
    const r = await runHunt(db, { trigger: 'schedule', checkSession: async () => ({ state: 'logged_out', checkedAt: null, detail: 'probe 401' }), notify: (t, b) => void h.toasts.push(`${t}: ${b}`) });
    expect(r).toMatchObject({ trigger: 'schedule', loginNeeded: true, found: 2, prepared: 0, readyForReview: 0, skipped: { 'prefilter: seniority': 1 } });
    expect(r.note).toMatch(/log in again/);
    expect(h.panels).toBe(0);
    expect(h.toasts).toEqual(['JobHunter hunt finished: Log in to Drushim again. Found 2 new job(s), discovery only.']);
    expect(recentHunts(db, 1)[0]).toMatchObject({ id: r.id, trigger: 'schedule', loginNeeded: true, found: 2 });
  });

  it('logged in → discover, score, prepare; the summary counts what is ready for review', async () => {
    const db = openDb(':memory:');
    h.panels = 0;
    const r = await runHunt(db, { checkSession: async () => ({ state: 'logged_in', checkedAt: null, detail: 'probe 401→200' }), notify: () => undefined });
    expect(r).toMatchObject({ trigger: 'manual', loginNeeded: false, found: 2, prepared: 1, readyForReview: 1, autoSubmitted: 0, failed: 0 });
    expect(h.panels).toBe(1);
  });

  it('Run & send: live steps and counts, and a "Done. Safe to close" summary', async () => {
    const db = openDb(':memory:');
    const seen: string[] = [];
    const r = await runHunt(db, {
      checkSession: async () => {
        seen.push(huntProgress()!.step);
        return { state: 'logged_in', checkedAt: null, detail: 'ok' };
      },
      notify: () => undefined,
    });
    expect(seen).toEqual(['checking the Drushim login']);
    const p = huntProgress()!;
    expect(p).toMatchObject({ id: r.id, step: 'done', finished: true, current: null, counts: { found: 2, candidates: 1, sent: 0, review: 1, failed: 0 } });
    expect(p.steps.map((s) => [s.name, s.state])).toEqual([
      ['checking the Drushim login', 'done'],
      ['discovering on Drushim → scoring', 'done'],
      ['preparing plans (not sending)', 'done'],
    ]);
    // auto-submit is off in this data folder (or DRY_RUN is on): prepare only, and the summary says why
    expect(r.sending).toMatch(/stopped after prepare|nothing is sent/);
    expect(r).toMatchObject({ sent: 0, waitingForReview: 1 });
    const done = doneReport(r, []);
    expect(done[0]).toBe('Done. Safe to close / shut down.');
    expect(done).toContain('found 2 new job(s)');
    expect(done).toContain('skipped 1 (prefilter: seniority 1)');
    expect(done).toContain('waiting for your review 1');
    expect(done.find((l) => l.startsWith('sent 0'))).toMatch(/stopped after prepare|nothing is sent/);
    expect(doneReport(r, ['the login window is open'])[0]).toMatch(/^Still running: the login window is open/);
  });

  it('one hunt at a time', async () => {
    const db = openDb(':memory:');
    const slowCheck = () => new Promise<never>(() => undefined);
    void runHunt(db, { checkSession: slowCheck, notify: () => undefined });
    await expect(runHunt(db, { notify: () => undefined })).rejects.toThrow(/already active/);
  });
});
