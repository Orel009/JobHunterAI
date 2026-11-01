/**
 * Role type settings: excludes in the title OR description (with "unless" phrases), the dev-content cap per role type,
 * opt-in role types that remove nothing while disabled, "never auto-submit", and the scorer's front-line support flag
 * (app-support jobs doing phone / chat / first-line work are skipped as "front-line support").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.DATA_DIR = 'data/test-roles';
  process.env.PREFERENCES_FILE = 'data/test-roles/preferences.yaml';
  Object.assign(process.env, { LLM_ANALYZE_PROVIDER: 'fake', LLM_ANALYZE_MODEL: 'test', LLM_WRITE_PROVIDER: 'fake', LLM_WRITE_MODEL: 'test' });
  return { frontLine: false };
});
vi.mock('../src/llm/score.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm/score.js')>()),
  candidateContext: () => 'candidate',
  scoreJob: async () => ({
    score: 80, matchedSkills: [], missingRequirements: [], seniorityFit: 'fit', reasoningHe: 'מתאים לתפקיד.', requiredYearsMin: null, requiredYearsQuote: null,
    seniority: 'junior', devContentScore: 30, isTrainingProgram: false, isFrontLineSupport: h.frontLine, model: 'm', cached: false,
  }),
}));

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { prefilter, primaryRole, roleExclude } from '../src/core/prefilter.js';
import { rankJob } from '../src/core/rank.js';
import { autoSubmitGate, type GateInput } from '../src/apply/auto-submit.js';
import { buildScoreMessages, ScoreSchema } from '../src/llm/score.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import { startRun, waitIdle } from '../src/pipeline/runner.js';

const YAML_ROLES = `
roleTypes:
  - { id: software, tier: 1, queries: [Software Developer], titleKeywords: [developer] }
  - id: solutions-integration
    tier: 2
    queries: [Integration Engineer]
    titleKeywords: [integration engineer, solutions engineer]
    devContentCap: false
  - id: app-support
    tier: 3
    queries: [Application Support]
    titleKeywords: [application support, production support, support engineer]
    excludeKeywords: [טלפוני, phone, tier 1, מוקד, משמרות]
    excludeUnless: { משמרות: [כוננות, on-call] }
    skipFrontLineSupport: true
    neverAutoSubmit: true
  - { id: platform-implementer, tier: 3, enabled: false, excludeTitlesWhenDisabled: false, queries: [x], titleKeywords: [Salesforce, monday] }
  - { id: off, tier: 3, enabled: false, queries: [x], titleKeywords: [analyst] }
`;
fs.mkdirSync(path.dirname(config.paths.preferences), { recursive: true });
fs.writeFileSync(config.paths.preferences, YAML_ROLES);
const prefs = PrefsSchema.parse((await import('yaml')).parse(YAML_ROLES));
const job = (title: string, descriptionText = '') => ({ title, company: 'x', location: '', descriptionText, roleTypes: [] as string[] });

describe('role type excludes (title or description)', () => {
  it('app-support: phone / first-line words in the title or description skip the job, with the word and where', () => {
    expect(prefilter(job('Application Support Engineer', 'מענה טלפוני ללקוחות'), prefs).reason).toBe('app-support: excluded "טלפוני" in the description');
    expect(prefilter(job('Production Support - Tier 1'), prefs).reason).toBe('app-support: excluded "tier 1" in the title');
    expect(prefilter(job('Support Engineer', 'Investigate production incidents with SQL, logs and APIs'), prefs).pass).toBe(true);
  });
  it('"משמרות" is fine when the text is about on-call for production', () => {
    expect(prefilter(job('Application Support', 'עבודה במשמרות'), prefs).reason).toMatch(/excluded "משמרות"/);
    expect(prefilter(job('Application Support', 'משמרות וכוננות לטיפול בתקלות פרודקשן'), prefs).pass).toBe(true);
  });
  it('only for jobs ranked as that role type', () => {
    expect(primaryRole(job('Full Stack Developer'), prefs)!.id).toBe('software');
    expect(prefilter(job('Full Stack Developer', 'phone app for our customers'), prefs).pass).toBe(true);
    expect(roleExclude(prefs.roleTypes[1]!, job('Integration Engineer', 'phone'))).toBeNull();
  });
});

describe('opt-in role types', () => {
  it('disabled with excludeTitlesWhenDisabled: false → removes nothing; the default still excludes its titles', () => {
    expect(prefilter(job('Salesforce Developer'), prefs).pass).toBe(true);
    expect(prefilter(job('Data Analyst Developer'), prefs).reason).toBe('role type disabled: off');
  });
});

describe('dev-content cap per role type', () => {
  const R = prefs.ranking;
  it('tier 3 by default; off for a role type scored on its own fit; on where asked', () => {
    expect(rankJob({ score: 80, devContentScore: 30, requiredYears: null, juniorText: null, tier: 3 }, R).score).toBe(30);
    expect(rankJob({ score: 80, devContentScore: 30, requiredYears: null, juniorText: null, tier: 3, devContentCap: false }, R).score).toBe(80);
    expect(rankJob({ score: 80, devContentScore: 30, requiredYears: null, juniorText: null, tier: 2, devContentCap: true }, R).score).toBe(30);
  });
});

describe('never auto-submit', () => {
  const base: GateInput = {
    dryRun: false, site: 'drushim', siteEnabled: true, paused: false, automatedFlow: true, rank: 99, minRank: 80,
    plan: { jobId: 'j', site: 'drushim', createdAt: '', cv: { lang: 'en', cvName: 'cv.pdf', hebrewRatio: 0, threshold: 0.2 }, fields: [], readiness: 'ready', notes: [] },
    descriptionText: 'x', company: 'Acme', companyNorm: 'acme', cooldownDays: 30, recentlyAppliedToCompany: false, excludedMatch: null, submittedToday: 0, dailyLimit: 15,
  };
  it('a role type set to never auto-submit keeps the job in review, whatever the rank', () => {
    expect(autoSubmitGate(base).auto).toBe(true);
    const g = autoSubmitGate({ ...base, neverAutoRoles: ['app-support'] });
    expect(g.auto).toBe(false);
    expect(g.conditions.find((c) => !c.ok)!.detail).toMatch(/role type app-support: never auto-submitted/);
  });
});

describe('the scorer and front-line support', () => {
  it('the schema and the prompt carry isFrontLineSupport', () => {
    expect(Object.keys(ScoreSchema.shape)).toContain('isFrontLineSupport');
    expect(buildScoreMessages({ title: 't', company: 'c', location: '', descriptionText: 'd', requirementsText: '' }, 'cand')[0]!.content).toMatch(/isFrontLineSupport: true if the daily work is front-line support/);
  });

  let db: ReturnType<typeof openDb>;
  let repo: Repo;
  beforeEach(() => {
    db = openDb(':memory:');
    repo = new Repo(db);
  });
  const add = (title: string) => {
    const j = toJob({ site: 'drushim', externalId: String(Math.random()).slice(2, 9), company: 'x', title, location: '', descriptionText: 'Investigate incidents', requirementsText: '', url: `https://www.drushim.co.il/job/${Math.random()}/`, postedAt: null, applyType: 'site_one_click', applyTarget: '', language: 'en', detailsFetched: true, raw: {} });
    repo.upsertJob(j);
    return j.id;
  };

  it('an app-support job the scorer flags as front-line → skipped "front-line support"; other role types ignore the flag', async () => {
    h.frontLine = true;
    const support = add('Application Support Engineer');
    const dev = add('Software Developer');
    startRun(db, 'drushim', 'score');
    await waitIdle();
    expect(repo.getJob(support)).toMatchObject({ status: 'skipped', statusReason: 'front-line support' });
    expect(repo.getJob(dev)!.status).toBe('scored');
  });

  it('not flagged → scored as usual', async () => {
    h.frontLine = false;
    const support = add('Production Support Engineer');
    startRun(db, 'drushim', 'score');
    await waitIdle();
    expect(repo.getJob(support)!.status).toBe('scored');
  });
});

const QA = PrefsSchema.parse(
    (await import('yaml')).parse(`
roleTypes:
  - { id: automation, tier: 2, queries: [QA Automation], titleKeywords: [automation, אוטומציה, Playwright, QA automation] }
  - { id: manual-qa, tier: 3, neverAutoSubmit: true, queries: [בודק תוכנה], titleKeywords: [בודק/ת תוכנה, בודקת תוכנה, QA ידני, בדיקות ידניות, manual QA, manual tester, בודק ידני, בודקת ידנית, בודק/ת ידני/ת] }
`),
);
describe('manual QA (tier 3, never auto-submit)', () => {
  const role = (title: string) => primaryRole({ title, roleTypes: [] }, QA)?.id ?? null;
  it('manual testing titles are manual-qa; a title with automation keeps automation', () => {
    expect(['דרוש/ה בודק/ת תוכנה', 'בודקת תוכנה', 'QA ידני', 'מהנדס/ת בדיקות ידניות', 'Manual QA Engineer', 'Manual Tester', 'בודק/ת ידני/ת מנוסה', 'בודקת ידנית'].map(role)).toEqual(Array(8).fill('manual-qa'));
    expect(['דרוש/ה בודק/ת תוכנה ידני ואוטומציה', 'Manual & Automation QA', 'QA Automation Engineer'].map(role)).toEqual(['automation', 'automation', 'automation']);
    expect(QA.roleTypes.find((r) => r.id === 'manual-qa')).toMatchObject({ tier: 3, neverAutoSubmit: true });
  });
});
