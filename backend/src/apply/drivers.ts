/**
 * The apply flow of each site with an automated apply (Drushim, JobMaster, Jobnet), behind one interface so preparing,
 * approving, batch approval and auto-submit work the same way for every site. Each function calls the site module
 * at call time.
 */
import type { Page } from 'playwright';
import type { StoredJob } from '../db/repo.js';
import type { PanelState } from '../sites/apply-error.js';
import type { ApplyPlan } from './types.js';
import * as drushim from '../sites/drushim/apply.js';
import * as jobmaster from '../sites/jobmaster/apply.js';
import * as jobnet from '../sites/jobnet/apply.js';

export type SendOutcome = { kind: 'submitted' } | { kind: 'already_applied'; sentDate: string } | { kind: 'failed' | 'error'; message: string; needsLogin?: boolean; fatalForDay?: boolean };
export interface SubmitResult {
  outcome: SendOutcome;
  confirmationText: string | null;
  screenshotAfter: string | null;
}

export interface ApplyDriver {
  site: string;
  label: string;
  openPanel(page: Page, job: StoredJob): Promise<PanelState>;
  fillPanel(page: Page, state: PanelState, plan: ApplyPlan): Promise<void>;
  /** evidence of the filled panel before the final click */
  screenshotPanel(page: Page, name: string): Promise<string>;
  installDryRunGuard(page: Page): Promise<() => Promise<void>>;
  /** cvName: the planned CV, checked in the send request where the site posts it */
  submitPanel(page: Page, job: StoredJob, shotName: string, cvName?: string): Promise<SubmitResult>;
  /** the site's own list of jobs this account applied to (job id → date sent) */
  fetchAppliedJobs(page: Page): Promise<Map<string, string | null>>;
}

export const DRIVERS: Record<string, ApplyDriver> = {
  drushim: {
    site: 'drushim',
    label: 'Drushim',
    openPanel: (page, job) => drushim.openPanel(page, job.url),
    fillPanel: (page, state, plan) => drushim.fillPanel(page, state as drushim.PanelState, plan),
    screenshotPanel: (page, name) => drushim.screenshotPanel(page, name),
    installDryRunGuard: (page) => drushim.installDryRunGuard(page),
    submitPanel: (page, job, name) => drushim.submitPanel(page, Number(job.externalId), name),
    fetchAppliedJobs: (page) => drushim.fetchAppliedJobs(page),
  },
  jobmaster: {
    site: 'jobmaster',
    label: 'JobMaster',
    openPanel: (page, job) => jobmaster.openPanel(page, job),
    fillPanel: (page, state, plan) => jobmaster.fillPanel(page, state, plan),
    screenshotPanel: (page, name) => jobmaster.screenshotPanel(page, name),
    installDryRunGuard: (page) => jobmaster.installDryRunGuard(page),
    submitPanel: (page, job, name) => jobmaster.submitPanel(page, job, name),
    fetchAppliedJobs: (page) => jobmaster.fetchAppliedJobs(page),
  },
  jobnet: {
    site: 'jobnet',
    label: 'Jobnet',
    openPanel: (page, job) => jobnet.openPanel(page, job),
    fillPanel: (page, state, plan) => jobnet.fillPanel(page, state, plan),
    screenshotPanel: (page, name) => jobnet.screenshotPanel(page, name),
    installDryRunGuard: (page) => jobnet.installDryRunGuard(page),
    submitPanel: (page, job, name, cvName) => jobnet.submitPanel(page, job, name, cvName),
    fetchAppliedJobs: (page) => jobnet.fetchAppliedJobs(page),
  },
};

export const driverFor = (site: string): ApplyDriver | null => DRIVERS[site] ?? null;
export const hasApplyFlow = (site: string): boolean => site in DRIVERS;

export { cvNamesFor } from './cv-names.js';
