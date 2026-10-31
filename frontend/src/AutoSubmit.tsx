import { useEffect, useState } from 'react';
import type { Status } from './api';

interface AutoSettings {
  sites: Record<string, boolean>;
  minRank: number | null;
  minRankEffective: number;
  minRankEnv: number;
  paused: boolean;
  pausedAt: string | null;
  dryRun: boolean;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: body === undefined ? 'POST' : 'PUT', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** The kill switch in the header: visible whenever auto-submit is on for any site. */
export function AutoSubmitKillSwitch({ status, onChange, openSettings }: { status: Status; onChange: () => void; openSettings: () => void }) {
  const a = status.autoSubmit;
  const anyOn = Object.values(a.sites).some(Boolean);
  if (!anyOn) return null;
  if (a.paused)
    return (
      <button className="badge warn" title={`paused at ${a.pausedAt ?? ''}`} onClick={openSettings}>
        ⏸ Auto-submit paused — resume in Settings
      </button>
    );
  return (
    <button className="danger kill-switch" title="stops auto-submit for every site immediately" onClick={() => void post('/api/auto-submit/pause').then(onChange)}>
      ⏸ Pause auto-submit
    </button>
  );
}

const CONDITIONS = [
  'DRY_RUN is off, auto-submit is on for the site, and not paused',
  'rank ≥ the minimum below',
  'every answer and statement from your profile / answers bank: no drafts, nothing pending, nothing written by the model (bank answers must match the question exactly)',
  'no application to the same company within the cooldown (Preferences → company cooldown); confidential companies never qualify',
  'the company is not on your excluded list',
  "under today's limit for that site",
  'the job has a full description (not "incomplete info")',
];

/** Settings card: per-site auto-submit (off by default) with a clear warning, the minimum rank, and resume. */
export function AutoSubmitCard({ sites, onSaved }: { sites: Status['sites']; onSaved?: () => void }) {
  const [s, setS] = useState<AutoSettings | null>(null);
  const [rank, setRank] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    const r = (await (await fetch('/api/auto-submit')).json()) as AutoSettings;
    setS(r);
    setRank(r.minRank === null ? '' : String(r.minRank));
  };
  useEffect(() => {
    void load();
  }, []);
  if (!s) return null;

  const toggle = async (site: string, on: boolean) => {
    if (
      on &&
      !window.confirm(
        `Turn ON auto-submit for ${site}?\n\nJobHunter will SEND applications on ${site} without asking you, whenever every gate condition holds (DRY_RUN off, rank ≥ ${s.minRankEffective}, every answer from your profile / bank, cooldown, daily limit…).\n\nYou can stop it at any time with "Pause auto-submit" in the header.`,
      )
    )
      return;
    await post('/api/auto-submit', { sites: { [site]: on } });
    setMsg(on ? `auto-submit ON for ${site}` : `auto-submit off for ${site}`);
    await load();
    onSaved?.();
  };

  return (
    <fieldset className="card">
      <legend>Auto-submit (off by default)</legend>
      <div className="banner error">
        <div dir="rtl">
          זהירות: כשהאפשרות פעילה, המערכת <b>שולחת הגשות אמיתיות בלי לשאול</b>, אם כל התנאים מתקיימים. כל שאר ההגשות ממשיכות לתור האישור כרגיל. הכפתור "Pause auto-submit"
          בראש המסך עוצר הכל מיד.
        </div>
        <div>
          Careful: when on, JobHunter <b>sends real applications without asking you</b> whenever every condition below holds. Everything else still goes to the review queue.
          "Pause auto-submit" in the header stops it immediately for all sites.
        </div>
      </div>
      {s.dryRun && <p className="note">DRY_RUN=true: nothing is ever sent, so auto-submit cannot act until DRY_RUN=false.</p>}
      {s.paused && (
        <p>
          <b>Paused</b> since {s.pausedAt?.replace('T', ' ').slice(0, 16)}.{' '}
          <button onClick={() => void post('/api/auto-submit/resume').then(load).then(() => onSaved?.())}>Resume auto-submit</button>
        </p>
      )}
      {sites
        .filter((x) => x.enabled)
        .map((x) => (
          <label key={x.id} className="row">
            <input type="checkbox" checked={!!s.sites[x.id]} onChange={(e) => void toggle(x.id, e.target.checked)} /> Auto-submit on <b>{x.displayName}</b>
          </label>
        ))}
      <div className="row">
        <label>
          Minimum rank{' '}
          <input type="number" min={0} max={200} value={rank} placeholder={String(s.minRankEnv)} onChange={(e) => setRank(e.target.value)} style={{ width: 80 }} />
        </label>
        <button onClick={() => void post('/api/auto-submit', { minRank: rank === '' ? null : Number(rank) }).then(load).then(() => setMsg('saved'))}>Save</button>
        <span className="muted">
          in use: {s.minRankEffective}
          {s.minRank === null ? ' (AUTO_SUBMIT_MIN_RANK)' : ''}
        </span>
        {msg && <span className="note">{msg}</span>}
      </div>
      <p className="muted">Sent automatically only when ALL of these hold (every check is recorded and shown in History):</p>
      <ul className="muted">
        {CONDITIONS.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </fieldset>
  );
}
