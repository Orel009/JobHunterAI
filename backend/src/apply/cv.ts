import type { CvChoice } from './types.js';

/** Hebrew letters / (Hebrew + Latin letters). Deterministic, no LLM. */
export function hebrewRatio(text: string): number {
  const he = (text.match(/[א-ת]/g) ?? []).length;
  const la = (text.match(/[A-Za-z]/g) ?? []).length;
  return he + la === 0 ? 1 : he / (he + la);
}

/**
 * English CV only when Hebrew letters are below the threshold (default 0.2) of all letters in
 * title + description + requirements. Typical Israeli posts (Hebrew with English tech terms) get the Hebrew CV.
 */
export function chooseCv(
  job: { title: string; descriptionText: string; requirementsText: string },
  cv: { he: string; en: string },
  threshold: number,
): CvChoice {
  const ratio = hebrewRatio(`${job.title}\n${job.descriptionText}\n${job.requirementsText}`);
  const lang = ratio < threshold ? 'en' : 'he';
  return { lang, cvName: cv[lang], hebrewRatio: Math.round(ratio * 1000) / 1000, threshold };
}
