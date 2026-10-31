export type FieldType = 'text' | 'textarea' | 'yes_no' | 'choice' | 'number' | 'consent';

export interface FormField {
  /** stable key within the form (e.g. "screening.0", "coverLetter", "consent") */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

/** user = typed in the review queue for this application only (not saved to the bank) */
export type ProvenanceSource = 'profile' | 'bank' | 'skill_years' | 'declared_experience' | 'draft' | 'user' | 'none';

export interface Provenance {
  source: ProvenanceSource;
  /** profile fact id ("contact.phone", "skill.react") or answers-bank entry id */
  ref?: string;
  confidence?: number;
  detail?: string;
  usedFactIds?: string[];
  flaggedClaims?: string[];
}

/**
 * resolved: has a value from profile/bank/skill years.
 * draft: LLM free-text draft (never auto-submitted).
 * pending: needs an answer from the user (saved to the bank as pending).
 * empty_optional: optional field left empty on purpose.
 */
export type FieldStatus = 'resolved' | 'draft' | 'pending' | 'empty_optional';

export interface ResolvedField {
  field: FormField;
  normKey: string;
  status: FieldStatus;
  value: string | null;
  provenance: Provenance;
  /** why it is pending / why a draft was rejected */
  reason?: string;
  /** hard-rule category that blocked LLM answering, if any */
  category?: string | null;
}

export interface CvChoice {
  lang: 'he' | 'en';
  cvName: string;
  hebrewRatio: number;
  threshold: number;
  overridden?: boolean;
}

export interface ApplyPlan {
  jobId: string;
  site: string;
  createdAt: string;
  cv: CvChoice | null;
  fields: ResolvedField[];
  /** ready: everything resolved; needs_answers: pending items; has_drafts; blocked_no: a required statement is false for the candidate */
  readiness: 'ready' | 'needs_answers' | 'has_drafts' | 'blocked_no';
  notes: string[];
}
