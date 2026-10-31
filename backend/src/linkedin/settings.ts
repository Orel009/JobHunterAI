/**
 * LinkedIn job alerts (email) — optional, OFF by default.
 * The on/off switch, the date window and the mailbox are in data/settings.json; the IMAP host/user/app password are
 * in .env only (the password is never stored elsewhere, never logged, and only returned masked).
 * Nothing here opens LinkedIn: jobs come from the alert emails, applying is done by the user in their own browser.
 */
import { maskKey, readSettingsFile, writeEnv, writeSettingsFile } from '../llm/settings.js';

export interface LinkedInSettings {
  enabled: boolean;
  /** only alert emails from the last N days are read */
  windowDays: number;
  mailbox: string;
}

const DEFAULTS: LinkedInSettings = { enabled: false, windowDays: 14, mailbox: 'INBOX' };

export function linkedInSettings(): LinkedInSettings {
  const s = (readSettingsFile() as { linkedinAlerts?: Partial<LinkedInSettings> }).linkedinAlerts ?? {};
  return {
    enabled: s.enabled === true,
    windowDays: Number.isInteger(s.windowDays) && s.windowDays! > 0 && s.windowDays! <= 90 ? s.windowDays! : DEFAULTS.windowDays,
    mailbox: typeof s.mailbox === 'string' && s.mailbox.trim() ? s.mailbox.trim() : DEFAULTS.mailbox,
  };
}

export const linkedInEnabled = (): boolean => linkedInSettings().enabled;

export function saveLinkedInSettings(patch: Partial<LinkedInSettings>): LinkedInSettings {
  const file = readSettingsFile();
  const next = { ...linkedInSettings(), ...patch };
  writeSettingsFile({ ...file, linkedinAlerts: next } as typeof file);
  return linkedInSettings();
}

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
  return { ...linkedInSettings(), imap: { host: c.host, port: c.port, user: c.user, password: maskKey(c.password) }, configured: imapConfigured(c) };
}
