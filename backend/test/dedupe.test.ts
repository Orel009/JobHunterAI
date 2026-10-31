import { describe, expect, it } from 'vitest';
import { findCrossSiteDuplicate, isCrossSiteDuplicate, type DedupeCandidate } from '../src/core/dedupe.js';

const job = { site: 'alljobs' as const, companyNorm: 'אלביט מערכות', titleNorm: 'מפתח full stack' };
const cand = (o: Partial<DedupeCandidate>): DedupeCandidate => ({
  id: 'x',
  site: 'drushim',
  companyNorm: 'אלביט מערכות',
  titleNorm: 'מפתח full stack',
  firstSeenAt: '2026-10-25T00:00:00Z',
  ...o,
});
const now = new Date('2026-10-31T00:00:00Z');

describe('cross-site dedupe', () => {
  it('matches same company + title within the window', () => {
    expect(isCrossSiteDuplicate(job, now, cand({}), 14)).toBe(true);
  });
  it('does not match outside the window', () => {
    expect(isCrossSiteDuplicate(job, now, cand({ firstSeenAt: '2026-10-01T00:00:00Z' }), 14)).toBe(false);
  });
  it('does not match on the same site (that is an upsert, not a dupe)', () => {
    expect(isCrossSiteDuplicate(job, now, cand({ site: 'alljobs' }), 14)).toBe(false);
  });
  it('never matches anonymous companies', () => {
    expect(isCrossSiteDuplicate({ ...job, companyNorm: 'חסוי' }, now, cand({ companyNorm: 'חסוי' }), 14)).toBe(false);
  });
  it('different title is not a dupe', () => {
    expect(isCrossSiteDuplicate(job, now, cand({ titleNorm: 'מפתח backend' }), 14)).toBe(false);
  });
  it('picks the earliest original', () => {
    const d = findCrossSiteDuplicate(
      job,
      now,
      [cand({ id: 'b', firstSeenAt: '2026-10-28T00:00:00Z' }), cand({ id: 'a', site: 'jobmaster', firstSeenAt: '2026-10-20T00:00:00Z' })],
      14,
    );
    expect(d?.id).toBe('a');
  });
});
