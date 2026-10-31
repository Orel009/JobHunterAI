/**
 * Reads LinkedIn job-alert emails over IMAP (Gmail with an app password). Read-only: the mailbox is opened with
 * EXAMINE, so nothing is marked as read, moved or deleted. Only messages from the job-alert sender inside the date
 * window are fetched, and only those whose Message-ID was not processed before.
 * The IMAP libraries are loaded on first use, so with the feature off they are never even imported.
 */
import { ALERT_SENDER } from './parse.js';
import { imapConfig, imapConfigured, linkedInSettings } from './settings.js';

export interface AlertEmail {
  messageId: string;
  date: string | null;
  html: string | null;
  text: string | null;
}

export class LinkedInDisabledError extends Error {
  constructor() {
    super('LinkedIn job alerts are turned off (Settings → LinkedIn job alerts)');
    this.name = 'LinkedInDisabledError';
  }
}

async function connect() {
  if (!linkedInSettings().enabled) throw new LinkedInDisabledError();
  const c = imapConfig();
  if (!imapConfigured(c)) throw new Error('IMAP is not set up: enter the email address and app password in Settings → LinkedIn job alerts');
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

/** Connection test: logs in, opens the mailbox read-only and counts alert emails in the window. */
export async function testImap(): Promise<{ mailbox: string; alerts: number; windowDays: number }> {
  const s = linkedInSettings();
  const client = await connect();
  try {
    const lock = await client.getMailboxLock(s.mailbox, { readOnly: true });
    try {
      const uids = await client.search({ from: ALERT_SENDER, since: new Date(Date.now() - s.windowDays * 86_400_000) }, { uid: true });
      return { mailbox: s.mailbox, alerts: uids ? uids.length : 0, windowDays: s.windowDays };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** New alert emails (not yet processed), parsed into their HTML and text parts. */
export async function fetchAlertEmails(opts: { isProcessed: (messageId: string) => boolean; signal?: AbortSignal }): Promise<AlertEmail[]> {
  const s = linkedInSettings();
  const client = await connect();
  try {
    const lock = await client.getMailboxLock(s.mailbox, { readOnly: true });
    try {
      const uids = await client.search({ from: ALERT_SENDER, since: new Date(Date.now() - s.windowDays * 86_400_000) }, { uid: true });
      if (!uids || uids.length === 0) return [];
      // envelopes first (small): keep only messages really from the alert sender and not processed yet
      const fresh: Array<{ uid: number; messageId: string }> = [];
      for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        const from = m.envelope?.from?.[0]?.address?.toLowerCase();
        const messageId = m.envelope?.messageId?.trim();
        if (from !== ALERT_SENDER || !messageId || opts.isProcessed(messageId)) continue;
        fresh.push({ uid: m.uid, messageId });
      }
      const { simpleParser } = await import('mailparser');
      const out: AlertEmail[] = [];
      for (const f of fresh) {
        if (opts.signal?.aborted) break;
        const m = await client.fetchOne(String(f.uid), { source: true }, { uid: true });
        if (!m || !m.source) continue;
        const mail = await simpleParser(m.source);
        out.push({ messageId: f.messageId, date: mail.date ? mail.date.toISOString() : null, html: typeof mail.html === 'string' ? mail.html : null, text: mail.text ?? null });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
