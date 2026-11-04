import { useState } from 'react';
import { api, type SitePause, type Status } from './api';

/** "Fri 06.11 12:40", Israel time */
const when = (iso: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day}.${p.month} ${p.hour}:${p.minute}`;
};

/**
 * Settings card: paused sites (any block pauses a site for 48 hours; a paused site is not loaded at all). "Resume" runs
 * ONE session check and resumes the site only if it serves its real page; challenged again after the pause → 7 days.
 */
export function SitePausesCard({ pauses, sites, busy, onChanged }: { pauses: Record<string, SitePause>; sites: Status['sites']; busy: boolean; onChanged?: () => void }) {
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const name = (id: string) => sites.find((s) => s.id === id)?.displayName ?? id;
  const resume = async (site: string) => {
    setChecking(site);
    setMsg((m) => ({ ...m, [site]: 'checking the site once…' }));
    try {
      const r = await api.resumeSite(site);
      setMsg((m) => ({ ...m, [site]: `${r.resumed ? '✓' : '✗'} ${r.detail}` }));
    } catch (e) {
      setMsg((m) => ({ ...m, [site]: `✗ ${(e as Error).message}` }));
    } finally {
      setChecking(null);
      onChanged?.();
    }
  };
  const entries = Object.entries(pauses);
  return (
    <fieldset className="card">
      <legend>Paused sites</legend>
      <p className="muted">
        Any block (bot protection, a CAPTCHA page, the site refusing pages, rate limiting) pauses that site for 48 hours. A paused site is not loaded at all: no discovery, no
        session checks, nothing prepared or sent, and Run & send leaves it out. After 48 hours, the next Run & send checks it once and resumes it only if it serves its real
        page; if the site challenges again at that check (or within 24 hours of resuming), it is paused for <b>7 days</b>. <b>Resume</b> runs that one check now. Times are
        Israel time.
      </p>
      {!entries.length && <p className="muted">No site is paused.</p>}
      {entries.map(([site, p]) => (
        <div key={site} className="row">
          <span className={`badge ${p.repause ? 'error' : 'warn'}`} title={p.detail}>
            {name(site)}: paused: {p.reason}
            {p.repause ? ' — 7 days (challenged again after a pause)' : ''}
          </span>
          <span className="muted">
            since {when(p.since)} ·{' '}
            {p.manualOnly ? 'disabled — never checked automatically; Resume checks it once' : p.expired ? 'pause over — checked at the next Run & send' : `paused until ${when(p.until)}, then checked once`}
          </span>
          <button disabled={busy || checking !== null} onClick={() => void resume(site)}>
            Resume {name(site)}
          </button>
          {msg[site] && <span className="note">{msg[site]}</span>}
        </div>
      ))}
      {Object.entries(msg)
        .filter(([site]) => !pauses[site])
        .map(([site, m]) => (
          <p key={site} className="note">
            {name(site)}: {m}
          </p>
        ))}
    </fieldset>
  );
}
