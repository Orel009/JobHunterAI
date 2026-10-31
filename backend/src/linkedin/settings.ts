/**
 * Email job alerts (LinkedIn, Indeed) — optional, OFF by default.
 * One switch for the feature plus one per source; the date window and the mailbox are shared. All in
 * data/settings.json (key emailAlerts; the older linkedinAlerts key is read once and carried over). The IMAP
 * host/user/app password are in .env only (the password is never stored elsewhere, never logged, and only returned
 * masked). Nothing here opens LinkedIn or Indeed: jobs come from the alert emails, applying is done by the user in
 * their own browser.
 */
import { maskKey, readSettingsFile, writeEnv, writeSettingsFile } from '../llm/settings.js';
import type { AssistedSite } from '../alerts/assisted.js';

export interface EmailAlertSettings {
  enabled: boolean;
  /** each source can be turned on separately */
  sources: Record<AssistedSite, boolean>;
  /** only alert emails from the last N days are read */
  windowDays: number;
  mailbox: string;
}
/** the older shape (LinkedIn only) */
export type LinkedInSettings = Omit<EmailAlertSettings, 'sources'>;

const DEFAULTS: EmailAlertSettings = { enabled: false, sources: { linkedin: true, indeed: false }, windowDays: 14, mailbox: 'INBOX' };

type Stored = { emailAlerts?: Partial<EmailAlertSettings>; linkedinAlerts?: Partial<LinkedInSettings> };

export function emailAlertSettings(): EmailAlertSettings {
  const file = readSettingsFile() as unknown as Stored;
  // before Indeed there was only linkedinAlerts: the same switch, with LinkedIn as its only source
  const s: Partial<EmailAlertSettings> = file.emailAlerts ?? (file.linkedinAlerts ? { ...file.linkedinAlerts, sources: { linkedin: true, indeed: false } } : {});
  return {
    enabled: s.enabled === true,
    sources: { linkedin: s.sources?.linkedin !== false, indeed: s.sources?.indeed === true },
    windowDays: Number.isInteger(s.windowDays) && s.windowDays! > 0 && s.windowDays! <= 90 ? s.windowDays! : DEFAULTS.windowDays,
    mailbox: typeof s.mailbox === 'string' && s.mailbox.trim() ? s.mailbox.trim() : DEFAULTS.mailbox,
  };
}

/** the feature is on and at least one source is on */
export const emailAlertsEnabled = (): boolean => {
  const s = emailAlertSettings();
  return s.enabled && Object.values(s.sources).some(Boolean);
};
export const sourceEnabled = (site: AssistedSite): boolean => {
  const s = emailAlertSettings();
  return s.enabled && s.sources[site];
};
export const enabledSources = (): AssistedSite[] => {
  const s = emailAlertSettings();
  return s.enabled ? (Object.keys(s.sources) as AssistedSite[]).filter((k) => s.sources[k]) : [];
};

export function saveEmailAlertSettings(patch: Partial<Omit<EmailAlertSettings, 'sources'>> & { sources?: Partial<Record<AssistedSite, boolean>> }): EmailAlertSettings {
  const file = readSettingsFile() as unknown as Stored & Record<string, unknown>;
  const cur = emailAlertSettings();
  const next: EmailAlertSettings = { ...cur, ...patch, sources: { ...cur.sources, ...(patch.sources ?? {}) } };
  const { linkedinAlerts: _old, ...rest } = file;
  writeSettingsFile({ ...rest, emailAlerts: next } as unknown as ReturnType<typeof readSettingsFile>);
  return emailAlertSettings();
}

// ---------- LinkedIn names (used across the app) ----------
export const linkedInSettings = (): LinkedInSettings => {
  const { sources: _s, ...rest } = emailAlertSettings();
  return rest;
};
export const linkedInEnabled = (): boolean => sourceEnabled('linkedin');
export const saveLinkedInSettings = (patch: Partial<LinkedInSettings>): LinkedInSettings => {
  saveEmailAlertSettings(patch);
  return linkedInSettings();
};

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export function imapConfig(): ImapConfig {
  const port = Number(process.env.IMAP_PORT || 993);
  return {
    host: (process.env.IMAP_HOST || 'imap.gmail.com').trim(),
    port: Number.isInteger(port) && port > 0 ? port : 993,
    user: (process.env.IMAP_USER || '').trim(),
    // Gmail shows app passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it
    password: (process.env.IMAP_APP_PASSWORD || '').replace(/\s+/g, ''),
  };
}

export const imapConfigured = (c = imapConfig()) => !!(c.host && c.user && c.password);

export function setImapConfig(v: { host?: string; port?: number; user?: string; password?: string | null }): void {
  const env: Record<string, string> = {};
  if (v.host !== undefined) env.IMAP_HOST = v.host.trim();
  if (v.port !== undefined) env.IMAP_PORT = String(v.port);
  if (v.user !== undefined) env.IMAP_USER = v.user.trim();
  if (v.password !== undefined) env.IMAP_APP_PASSWORD = (v.password ?? '').replace(/\s+/g, '');
  writeEnv(env);
}

export function publicLinkedInSettings() {
  const c = imapConfig();
  return { ...emailAlertSettings(), imap: { host: c.host, port: c.port, user: c.user, password: maskKey(c.password) }, configured: imapConfigured(c) };
}
