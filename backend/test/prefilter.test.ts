import { describe, expect, it } from 'vitest';
import { prefilter } from '../src/core/prefilter.js';
import { PrefsSchema } from '../src/core/prefs.js';

const prefs = PrefsSchema.parse({
  locations: ['תל אביב', 'רמת גן', 'פתח תקווה'],
  filters: {
    includeTitleKeywords: ['full stack', 'fullstack', 'backend', 'מפתח', 'developer'],
    excludeTitleKeywords: ['QA', 'בודק', 'מכירות'],
    excludeSeniorityKeywords: ['בכיר', 'בכירה', 'ראש צוות', 'senior', 'team lead', 'מנהל'],
    excludeCompanies: ['חברה רעה בע"מ'],
    remoteKeywords: ['מהבית', 'remote', 'כל הארץ'],
  },
});
const j = (title: string, location = 'תל אביב', company = 'acme') => ({ title, location, company });

describe('prefilter', () => {
  it('passes a matching title in an accepted city', () => {
    expect(prefilter(j('מפתח/ת Full Stack'), prefs)).toEqual({ pass: true, reason: 'ok' });
  });
  it('rejects seniority words in Hebrew and English (incl. feminine form)', () => {
    expect(prefilter(j('מפתחת Backend בכירה'), prefs).pass).toBe(false);
    expect(prefilter(j('Senior Backend Developer'), prefs).reason).toMatch(/seniority/);
    expect(prefilter(j('ראש צוות פיתוח'), prefs).pass).toBe(false);
  });
  it('rejects excluded title keywords', () => {
    expect(prefilter(j('QA Developer'), prefs).reason).toMatch(/excluded title/);
  });
  it('requires an include keyword', () => {
    expect(prefilter(j('נציג שירות לקוחות'), prefs).reason).toBe('no include keyword in title');
  });
  it('rejects locations outside the list, accepts remote, unknown and multi-city', () => {
    expect(prefilter(j('Backend Developer', 'חיפה'), prefs).pass).toBe(false);
    expect(prefilter(j('Backend Developer', 'עבודה מהבית'), prefs).pass).toBe(true);
    expect(prefilter(j('Backend Developer', ''), prefs).pass).toBe(true);
    expect(prefilter(j('Backend Developer', 'חיפה, פתח תקווה'), prefs).pass).toBe(true);
  });
  it('rejects excluded companies after normalization', () => {
    expect(prefilter(j('Backend Developer', 'תל אביב', 'חברה רעה'), prefs).reason).toMatch(/excluded company/);
  });
  it('empty filters pass everything', () => {
    expect(prefilter(j('anything', 'anywhere'), PrefsSchema.parse({})).pass).toBe(true);
  });
});
