/**
 * Hebrew grammatical gender for every prompt that writes Hebrew in the candidate's voice or about the candidate.
 * Driven by profile.gender — nothing about the user is assumed in code.
 */
export type Gender = 'male' | 'female' | null | undefined;

/** First-person Hebrew (answers written AS the candidate). */
export function hebrewFirstPersonRule(gender: Gender): string {
  if (gender === 'female') return 'המועמדת היא אישה: כתבי בגוף ראשון בלשון נקבה תקנית (למשל "עבדתי", "אני מתעניינת", "אני מגיעה", "אני זמינה").';
  if (gender === 'male') return 'המועמד הוא גבר: כתוב בגוף ראשון בלשון זכר תקנית (למשל "עבדתי", "אני מתעניין", "אני מגיע", "אני זמין").';
  return 'מגדר המועמד/ת לא ידוע: נסח בגוף ראשון בצורות נייטרליות (זמן עבר, שם פועל, "יש לי ניסיון ב…") והימנע מצורות הווה ממוגדרות.';
}

/** Third-person Hebrew (text ABOUT the candidate, e.g. the score reasoning). */
export function hebrewThirdPersonRule(gender: Gender): string {
  if (gender === 'female') return 'The candidate is a woman: in Hebrew refer to her with feminine forms (המועמדת, היא, בעלת, מתאימה).';
  if (gender === 'male') return 'The candidate is a man: in Hebrew refer to him with masculine forms (המועמד, הוא, בעל, מתאים).';
  return 'The candidate\'s gender is unknown: in Hebrew write "המועמד/ת" and avoid gendered verb forms where possible.';
}
