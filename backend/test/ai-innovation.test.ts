import { describe, expect, it } from 'vitest';
import { allowedSeniority, isTeamLead, prefilter, scoringRole } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';

const roles = (allow: string[] = ['מוביל', 'AI Lead', 'Innovation Lead'], enabled = true) => [
  { id: 'software', tier: 1, queries: ['x'], titleKeywords: ['developer', 'מפתח', 'מפתחת'] },
  { id: 'ai', tier: 2, queries: ['x'], titleKeywords: ['AI', 'LLM', 'GenAI', 'בינה מלאכותית'] },
  {
    id: 'ai-innovation',
    tier: 2,
    enabled,
    queries: ['חדשנות AI'],
    titleKeywords: ['חדשנות', 'AI', 'GenAI', 'בינה מלאכותית', 'הטמעה', 'טרנספורמציה', 'Innovation', 'Enablement', 'Adoption'],
    allowSeniorityWords: allow,
  },
];
const prefs = (allow?: string[], enabled?: boolean) =>
  PrefsSchema.parse({ roleTypes: roles(allow, enabled), filters: { excludeSeniorityKeywords: ['Senior', 'Lead', 'Team Lead', 'Head of', 'Director', 'Manager', 'ראש צוות', 'מנהל'] } });
const pf = (title: string, p = prefs()) => prefilter({ title, company: 'x', location: '' }, p);

describe('allowSeniorityWords: "מוביל/ת" and "AI Lead" for AI-innovation titles only', () => {
  it.each(['מוביל/ת חדשנות ו-AI, חולון/באר שבע', 'מוביל/ת חדשנות ו-AI Business AI & Innovation Lead', 'מובילה טכנולוגית GenAI', 'AI Lead', 'Innovation Lead – הטמעת AI'])(
    'passes: %s',
    (t) => expect(pf(t)).toEqual({ pass: true, reason: 'ok' }),
  );

  it.each([
    ['ראש צוות AI', 'seniority: "ראש צוות"'],
    ['Head of AI Innovation', 'seniority: "Head of"'],
    ['Senior AI Adoption Specialist', 'seniority: "Senior"'],
    ['Team Lead GenAI', 'seniority: "Lead"'],
    ['מנהל חדשנות AI', 'seniority: "מנהל"'],
    ['מוביל/ת צוות פיתוח', 'seniority: "מוביל/ת" (team / domain lead)'],
    ['מוביל/ת צוות AI', 'seniority: "מוביל/ת" (team / domain lead)'],
  ])('still skipped: %s', (t, reason) => expect(pf(t).reason).toBe(reason));

  it('only with an ai-innovation keyword in the title: the same lead role elsewhere is skipped', () => {
    expect(pf('מוביל/ה טכנולוגי/ת QA & Automation').pass).toBe(false);
    expect(pf('מוביל/ה הנדסת מערכת תוכנה').pass).toBe(false);
  });

  it('configurable, not hard-coded: without the allow list, or with the role type off, the Oron title is skipped', () => {
    expect(pf('מוביל/ת חדשנות ו-AI', prefs([])).reason).toMatch(/team \/ domain lead/);
    expect(pf('מוביל/ת חדשנות ו-AI', prefs(undefined, false)).reason).toMatch(/team \/ domain lead/);
    expect(allowedSeniority('מוביל/ת חדשנות ו-AI', prefs().roleTypes)).toEqual({ phrases: ['מוביל', 'AI Lead', 'Innovation Lead'], lead: true });
    expect(isTeamLead('מוביל/ת צוות AI')).toBe(true);
    expect(isTeamLead('מוביל/ת חדשנות')).toBe(false);
  });

  it('within a tier, the role type with more matching keywords decides (AI innovation vs. AI development)', () => {
    expect(scoringRole({ title: 'מוביל/ת חדשנות ו-AI', roleTypes: [] }, prefs())?.id).toBe('ai-innovation');
    expect(scoringRole({ title: 'GenAI Engineer', roleTypes: [] }, prefs())?.id).toBe('ai'); // tie → list order
    expect(scoringRole({ title: 'AI Developer', roleTypes: [] }, prefs())?.id).toBe('software'); // tier 1 wins
  });

  it('a scored job that now counts as another role type is found for re-scoring', () => {
    const db = openDb(':memory:');
    const repo = new Repo(db);
    const raw = { site: 'drushim' as const, externalId: '1', company: 'Oron', title: 'מוביל/ת חדשנות ו-AI', location: '', descriptionText: '', requirementsText: '', url: 'u', postedAt: null, applyType: 'site_one_click' as const, applyTarget: '', language: 'he' as const, detailsFetched: true, raw: {} };
    const j = toJob(raw);
    repo.upsertJob(j);
    repo.setPrefilter(j.id, true, 'ok');
    repo.saveScore(j.id, { score: 60, matchedSkills: [], missingRequirements: [], seniorityFit: 'ok', reasoningHe: 'x', model: 'm', contentHash: j.contentHash, roleType: 'ai' });
    const p = prefs();
    const stale = repo.scoredWithRole('drushim').filter((x) => (scoringRole(x, p)?.id ?? null) !== x.scoredRole);
    expect(stale.map((x) => [x.title, x.scoredRole, scoringRole(x, p)?.id])).toEqual([['מוביל/ת חדשנות ו-AI', 'ai', 'ai-innovation']]);
  });
});
