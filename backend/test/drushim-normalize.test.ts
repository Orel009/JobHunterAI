import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fromApiJob, fromJobPage, fromSsrSearchJob, jobPageFromNextData, ssrSearchJobs, type DrushimApiJob } from '../src/sites/drushim/normalize.js';
import { toJob, jobId } from '../src/core/job.js';

const fx = (f: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as unknown;
const apiList = () => (fx('drushim-api-search.json') as { ResultList: DrushimApiJob[] }).ResultList;

describe('drushim normalizers', () => {
  it('maps search-page SSR jobs', () => {
    const { jobs, totalPages } = ssrSearchJobs(fx('drushim-search-ssr.json'));
    expect(jobs).toHaveLength(3);
    expect(totalPages).toBe(6);
    const r = fromSsrSearchJob(jobs[0]!);
    expect(r).toMatchObject({
      site: 'drushim',
      externalId: '38822551',
      title: 'Full Stack Developer',
      company: 'חסוי',
      location: 'פתח תקווה',
      url: 'https://www.drushim.co.il/job/38822551/3d25aca1/',
      applyType: 'site_one_click',
      applyTarget: 'https://www.drushim.co.il/sendcv.aspx?jobcode=38822551',
      detailsFetched: false,
      language: 'he',
    });
    expect(r.postedAt).toBe('2026-10-22T07:47:32.160Z');
    expect(r.descriptionText).toContain('Node.js');
  });

  it('maps webapi search results (load more)', () => {
    const list = apiList();
    const r = fromApiJob(list[0]!);
    expect(r.externalId).toBe(String(list[0]!.Code));
    expect(r.title).toContain('COBOL');
    expect(r.requirementsText.length).toBeGreaterThan(10);
    expect(r.descriptionText).not.toMatch(/<br/);
    expect(r.detailsFetched).toBe(true);
    expect(r.url).toMatch(/^https:\/\/www\.drushim\.co\.il\/job\//);
  });

  it('classifies apply types', () => {
    const base = apiList()[0]!;
    const ext = fromApiJob({ ...base, SendCVButtonModel: { ExternalLink: 'https://careers.example.com/1', ButtonLink: '' } });
    expect(ext.applyType).toBe('external');
    expect(ext.applyTarget).toBe('https://careers.example.com/1');
    const q = fromApiJob({ ...base, JobInfo: { ...base.JobInfo, HasFilter: true } });
    expect(q.applyType).toBe('site_questionnaire');
  });

  it('maps the job page SSR with requirements', () => {
    const { job, isGone } = jobPageFromNextData(fx('drushim-job-ssr.json'));
    expect(isGone).toBe(false);
    const r = fromJobPage(job!, '/job/38822551/3d25aca1/');
    expect(r.requirementsText).toContain('React');
    expect(r.descriptionText).toContain('שכר: 25000-30000');
    expect(r.detailsFetched).toBe(true);
    expect(toJob(r).id).toBe(jobId('drushim', '38822551'));
  });

  it('same job from search card and job page has the same id', () => {
    const card = fromSsrSearchJob(ssrSearchJobs(fx('drushim-search-ssr.json')).jobs[0]!);
    const page = fromJobPage(jobPageFromNextData(fx('drushim-job-ssr.json')).job!, card.url);
    expect(toJob(card).id).toBe(toJob(page).id);
  });
});
