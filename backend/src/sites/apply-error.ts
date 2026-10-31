/** Errors of a site's apply flow (any site). */
export class ApplyError extends Error {
  constructor(
    public code:
      | 'not_logged_in'
      | 'panel_not_found'
      | 'cv_not_found'
      | 'already_applied'
      | 'unexpected_form'
      | 'site_error'
      | 'daily_limit'
      | 'no_apply_button'
      /** a safety check failed right before sending (e.g. "send to similar jobs" still ticked): never sent */
      | 'unsafe_form',
    message: string,
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

/** whitespace collapsed; zero-width and bidi marks removed */
export const clean = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/[​-‏‪-‮⁦-⁩­﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** What an apply panel offers, as read by a site's driver. */
export interface PanelState {
  fields: import('../apply/types.js').FormField[];
  cvs: Array<{ code: string; name: string; checked: boolean }>;
  hasCoverLetter: boolean;
  /** site-specific details the driver needs when filling (e.g. JobMaster question types) */
  extra?: unknown;
}
