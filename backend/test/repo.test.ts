import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { toJob } from '../src/core/job.js';
import type { RawJob } from '../src/sites/types.js';

const raw = (o: Partial<RawJob> = {}): RawJob => ({
  site: 'drushim',
  externalId: '1',
  company: 'Acme',
  title: 'מפתח Backend',
  location: 'תל אביב',
  descriptionText: 'short card text',
  requirementsText: '',
  url: 'https://www.drushim.co.il/job/1/a/',
  postedAt: null,
  applyType: 'site_one_click',
  applyTarget: 'x',
  language: 'he',
  detailsFetched: false,
  raw: {},
  ...o,
});

describe('Repo.upsertJob', () => {
  it('inserts once and never duplicates', () => {
    const repo = new Repo(openDb(':memory:'));
    expect(repo.upsertJob(toJob(raw())).outcome).toBe('inserted');
    expect(repo.upsertJob(toJob(raw())).outcome).toBe('unchanged');
    expect(repo.listJobs({}).total).toBe(1);
  });

  it('a later search card does not overwrite details from the job page', () => {
    const repo = new Repo(openDb(':memory:'));
    repo.upsertJob(toJob(raw()));
    repo.upsertJob(toJob(raw({ descriptionText: 'full text', requirementsText: 'React - חובה', detailsFetched: true, applyType: 'site_questionnaire' })));
    const { job, outcome } = repo.upsertJob(toJob(raw()));
    expect(outcome).toBe('unchanged');
    expect(job.requirementsText).toBe('React - חובה');
    expect(job.applyType).toBe('site_questionnaire');
    expect(job.detailsFetched).toBe(true);
  });

  it('prefilter + scoring flow updates status and re-scores on content change', () => {
    const repo = new Repo(openDb(':memory:'));
    const { job } = repo.upsertJob(toJob(raw()));
    repo.setPrefilter(job.id, true, 'ok');
    expect(repo.jobsNeedingScore().map((j) => j.id)).toEqual([job.id]);
    repo.saveScore(job.id, { score: 70, matchedSkills: [], missingRequirements: [], seniorityFit: 'fit', reasoningHe: 'x', model: 'm', contentHash: job.contentHash });
    expect(repo.getJob(job.id)!.status).toBe('scored');
    expect(repo.jobsNeedingScore()).toHaveLength(0);
    repo.upsertJob(toJob(raw({ descriptionText: 'changed', detailsFetched: true })));
    expect(repo.jobsNeedingScore()).toHaveLength(1);
  });

  it('prefilter failure marks discovered jobs as skipped with reason', () => {
    const repo = new Repo(openDb(':memory:'));
    const { job } = repo.upsertJob(toJob(raw()));
    repo.setPrefilter(job.id, false, 'seniority: "בכיר"');
    expect(repo.getJob(job.id)).toMatchObject({ status: 'skipped', statusReason: 'prefilter: seniority: "בכיר"' });
  });

  it('listJobs joins scores and filters by minScore', () => {
    const repo = new Repo(openDb(':memory:'));
    const { job } = repo.upsertJob(toJob(raw()));
    repo.upsertJob(toJob(raw({ externalId: '2' })));
    repo.saveScore(job.id, { score: 90, matchedSkills: ['React'], missingRequirements: [], seniorityFit: 'fit', reasoningHe: 'x', model: 'm', contentHash: job.contentHash });
    const res = repo.listJobs({ minScore: 80 });
    expect(res.total).toBe(1);
    expect(res.items[0]!.score?.matchedSkills).toEqual(['React']);
  });
});
