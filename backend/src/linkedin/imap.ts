/**
 * Reads job-alert emails (LinkedIn, Indeed) over IMAP (Gmail with an app password). Read-only: the mailbox is opened
 * with EXAMINE, so nothing is marked as read, moved or deleted. Only messages from each enabled source's alert
 * sender inside the date window are fetched, and only those whose Message-ID was not processed before.
 * The IMAP libraries are loaded on first use, so with the feature off they are never even imported.
 */
import type { AssistedSite } from '../alerts/assisted.js';
import { INDEED_SEARCH_FROM, isIndeedAlertSender } from '../alerts/indeed.js';
import { ALERT_SENDER } from './parse.js';
import { emailAlertsEnabled, emailAlertSettings, enabledSources, imapConfig, imapConfigured } from './settings.js';

export interface AlertEmail {
  messageId: string;
  date: string | null;
  html: string | null;
  text: string | null;
  /** which alert source sent it (default linkedin) */
  source?: AssistedSite;
}

/** Each source's IMAP search term (FROM, a substring match) and the exact sender check on the envelope. */
export const ALERT_SOURCES: Record<AssistedSite, { searchFrom: string; isSender: (address: string | undefined) => boolean }> = {
  linkedin: { searchFrom: ALERT_SENDER, isSender: (a) => a?.toLowerCase() === ALERT_SENDER },
  indeed: { searchFrom: INDEED_SEARCH_FROM, isSender: (a) => isIndeedAlertSender(a) },
};

export class LinkedInDisabledError extends Error {
  constructor() {
    super('Email job alerts are turned off (Settings → Email job alerts)');
    this.name = 'LinkedInDisabledError';
  }
}

async function connect() {
  if (!emailAlertsEnabled()) throw new LinkedInDisabledError();
  const c = imapConfig();
  if (!imapConfigured(c)) throw new Error('IMAP is not set up: enter the email address and app password in Settings → Email job alerts');
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.password }, logger: false });
  try {
    await client.connect();
  } catch (e) {
    const msg = (e as { authenticationFailed?: boolean }).authenticationFailed ? 'login failed — check the email address and the app password' : (e as Error).message;
    throw new Error(`IMAP ${c.host}: ${msg}`);
  }
  return client;
}

/** Connection test: logs in, opens the mailbox read-only and counts alert emails in the window, per source. */
export async function testImap(): Promise<{ mailbox: string; alerts: number; bySource: Partial<Record<AssistedSite, number>>; windowDays: number }> {
  const s = emailAlertSettings();
  const client = await connect();
  try {
    const lock = await client.getMailboxLock(s.mailbox, { readOnly: true });
    try {
      const bySource: Partial<Record<AssistedSite, number>> = {};
      for (const src of enabledSources()) {
        const uids = await client.search({ from: ALERT_SOURCES[src].searchFrom, since: new Date(Date.now() - s.windowDays * 86_400_000) }, { uid: true });
        bySource[src] = uids ? uids.length : 0;
      }
      return { mailbox: s.mailbox, alerts: Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0), bySource, windowDays: s.windowDays };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** New alert emails (not yet processed) of every enabled source, parsed into their HTML and text parts. */
export async function fetchAlertEmails(opts: { isProcessed: (messageId: string) => boolean; signal?: AbortSignal }): Promise<AlertEmail[]> {
  const s = emailAlertSettings();
  const client = await connect();
  try {
    const lock = await client.getMailboxLock(s.mailbox, { readOnly: true });
    try {
      const out: AlertEmail[] = [];
      const { simpleParser } = await import('mailparser');
      for (const source of enabledSources()) {
        const src = ALERT_SOURCES[source];
        const uids = await client.search({ from: src.searchFrom, since: new Date(Date.now() - s.windowDays * 86_400_000) }, { uid: true });
        if (!uids || uids.length === 0) continue;
        // envelopes first (small): keep only messages really from the alert sender and not processed yet
        const fresh: Array<{ uid: number; messageId: string }> = [];
        for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          const messageId = m.envelope?.messageId?.trim();
          if (!src.isSender(m.envelope?.from?.[0]?.address) || !messageId || opts.isProcessed(messageId)) continue;
          fresh.push({ uid: m.uid, messageId });
        }
        for (const f of fresh) {
          if (opts.signal?.aborted) break;
          const m = await client.fetchOne(String(f.uid), { source: true }, { uid: true });
          if (!m || !m.source) continue;
          const mail = await simpleParser(m.source);
          out.push({ messageId: f.messageId, date: mail.date ? mail.date.toISOString() : null, html: typeof mail.html === 'string' ? mail.html : null, text: mail.text ?? null, source });
        }
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
