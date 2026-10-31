/**
 * The apply-helper panel for a LinkedIn job: what to attach and what to paste into the Easy Apply form.
 * Everything comes from the profile and the answers bank; nothing is generated here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import type { StoredJob } from '../db/repo.js';
import { AnswersBank } from '../apply/bank.js';
import { hardRuleCategory } from '../apply/classify.js';
import { chooseCv } from '../apply/cv.js';
import { findSkill, loadProfile, skillYears } from '../profile/facts.js';
import { loadPrefs } from '../core/prefs.js';
import { composeSalaryAnswer } from '../core/salary.js';
import { jobSalaryContext } from '../apply/plan.js';

export interface HelperItem {
  label: string;
  value: string;
  /** where the value comes from (profile field, bank entry, computed) */
  source: string;
}

export interface ApplyHelper {
  cv: { lang: 'he' | 'en'; reason: string; file: string | null; exists: boolean };
  contact: HelperItem[];
  answers: HelperItem[];
  declared: { totalDevYears: number; basis: string } | null;
  skillYears: HelperItem[];
  /** salary expectation, by the same rules as applications (posted range / fallback / pending) */
  salary: HelperItem[];
  incompleteInfo: boolean;
}

export const localCvFile = (lang: 'he' | 'en') => path.join(config.paths.profileDir, `cv-${lang}.pdf`);

export function applyHelper(db: DB, job: StoredJob, matchedSkills: string[] = []): ApplyHelper {
  const choice = chooseCv(job, { he: 'he', en: 'en' }, config.ENGLISH_CV_MAX_HEBREW_RATIO);
  const file = localCvFile(choice.lang);
  const profile = loadProfile();

  const contact: HelperItem[] = [];
  if (profile) {
    const c = profile.contact;
    const lang = choice.lang;
    const pick = (b: { he: string | null; en: string | null }) => b[lang] ?? b[lang === 'he' ? 'en' : 'he'];
    const add = (label: string, value: string | null | undefined, source: string) => value && contact.push({ label, value, source });
    add('Full name', pick(c.name), 'profile: contact.name');
    add('Email', c.email, 'profile: contact.email');
    add('Phone', c.phone, 'profile: contact.phone');
    add('City', pick(c.city), 'profile: contact.city');
    for (const l of profile.links) add(l.label, l.url, `profile: links.${l.id}`);
  }

  const answers: HelperItem[] = new AnswersBank(db)
    .active()
    .filter((e) => e.answer)
    .map((e) => ({ label: e.question, value: e.answer!, source: `answers bank #${e.id}` }));

  const years: HelperItem[] = [];
  if (profile) {
    for (const mention of matchedSkills) {
      const s = findSkill(profile, mention);
      if (!s || s.level === 'basic' || years.some((y) => y.label === s.name)) continue;
      const y = skillYears(profile, s.id);
      if (y.years !== null) years.push({ label: s.name, value: String(y.years), source: y.source === 'stated' ? 'stated in your CV' : 'work roles linked to the skill' });
    }
  }

  const sal = jobSalaryContext(job, loadPrefs());
  // same order as applications: posted range → your answer in the bank → your salary settings → nothing (decide yourself)
  const bankSalary = new AnswersBank(db).active().filter((e) => e.answer && hardRuleCategory(e.question, 'text') === 'salary');
  const salary: HelperItem[] = (['text', 'number'] as const).map((kind) => {
    const label = kind === 'text' ? 'Salary expectation (text)' : 'Salary expectation (number only)';
    const a = composeSalaryAnswer(sal.posted, sal.settings, kind);
    if (a.basis !== 'posted range') {
      const e = bankSalary.find((x) => (kind === 'number' ? /^\d[\d,]*$/.test(x.answer!.trim()) : true));
      if (e) return { label, value: e.answer!, source: `answers bank #${e.id} (no salary posted)` };
    }
    return { label, value: a.value ?? '', source: `${a.basis}: ${a.detail}` };
  });

  return {
    cv: {
      lang: choice.lang,
      reason: `${Math.round(choice.hebrewRatio * 100)}% Hebrew letters in the ${job.descriptionText ? 'post' : 'title'} (English below ${Math.round(choice.threshold * 100)}%)`,
      file: path.basename(file),
      exists: fs.existsSync(file),
    },
    contact,
    answers,
    declared: profile?.declaredExperience ?? null,
    skillYears: years,
    salary,
    incompleteInfo: !job.descriptionText,
  };
}
