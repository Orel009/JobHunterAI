/**
 * LIVE (your real profile and model; skipped unless LIVE_LLM=1, e.g. `LIVE_LLM=1 npx vitest run test/live-draft.test.ts`
 * with Ollama running): the bio and the cover note for the careers-page ad in fixtures/form-bio.html (a stand-in with the
 * live ad's requirements until the real page is saved). They must draw on the ad's
 * requirements (React, JavaScript, REST, Node.js) that the profile really meets, must not claim the ad's "3+ years",
 * and must differ from one call to the next. Nothing is written to the page or sent anywhere.
 */
import { describe, expect, it, vi } from 'vitest';

// live: your real data folder (the test config points at data/test)
vi.hoisted(() => {
  if (process.env.LIVE_LLM === '1') Object.assign(process.env, { DATA_DIR: 'data', PREFERENCES_FILE: '' });
});

import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { coverLetterDraft } from '../src/extension/fill.js';
import { coverLetterProblem, yearsProblem } from '../src/apply/draft.js';
import { loadProfile } from '../src/profile/facts.js';

const LIVE = process.env.LIVE_LLM === '1';
const html = fs.readFileSync(new URL('./fixtures/form-bio.html', import.meta.url), 'utf8');
const ad = html
  .replace(/[\s\S]*<article class="job">|<\/article>[\s\S]*/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

describe.skipIf(!LIVE)('live drafts for the careers page ad (3+ years, React, JavaScript, REST, Node.js)', () => {
  it('the bio: the ad\'s stack, no claim of 3+ years, a fresh text each time', async () => {
    const db = openDb(config.paths.db);
    const years = loadProfile()?.declaredExperience?.totalDevYears ?? null;
    const texts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = await coverLetterDraft(db, { job: null, title: 'Full Stack Developer', company: 'Example Logistics', label: 'Bio *', lang: 'en', kind: 'bio', pageText: ad });
      expect(d.error).toBeNull();
      expect(d.context).toBe('page');
      const t = d.text!;
      expect(['React', 'JavaScript', 'REST', 'Node'].filter((w) => t.includes(w)).length).toBeGreaterThanOrEqual(2);
      expect(yearsProblem(t, years)).toBeNull();
      expect(t).not.toMatch(/3\+?\s*years/i);
      expect(coverLetterProblem(t, 3)).toBeNull();
      texts.push(t);
    }
    expect(texts[0]).not.toBe(texts[1]);
  }, 300_000);

  it('the cover note: the ad\'s requirements, no claim of 3+ years', async () => {
    const db = openDb(config.paths.db);
    const d = await coverLetterDraft(db, { job: null, title: 'Full Stack Developer', company: 'Example Logistics', label: 'Message', lang: 'en', kind: 'cover', pageText: ad });
    expect(d.error).toBeNull();
    expect(['React', 'JavaScript', 'REST', 'Node'].filter((w) => d.text!.includes(w)).length).toBeGreaterThanOrEqual(2);
    expect(yearsProblem(d.text!, loadProfile()?.declaredExperience?.totalDevYears ?? null)).toBeNull();
  }, 300_000);
});
