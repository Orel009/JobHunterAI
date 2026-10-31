import { useEffect, useState } from 'react';

export interface HuntSummary {
  id: number;
  trigger: 'manual' | 'schedule' | 'task' | 'cli';
  startedAt: string;
  finishedAt: string;
  found: number;
  skipped: Record<string, number>;
  readyForReview: number;
  autoSubmitted: number;
  failed: number;
  sent?: number;
  waitingForReview?: number;
  sending?: string;
  loginNeeded: boolean;
  note: string | null;
  error?: string;
}

const TRIGGER: Record<HuntSummary['trigger'], string> = { manual: 'started by you', schedule: 'in-app schedule', task: 'Windows Task Scheduler', cli: 'npm start -- --hunt' };
const time = (iso: string) => new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The latest hunt's summary, shown in the dashboard after every run. */
export function HuntSummaryLine({ h, onLogin }: { h: HuntSummary; onLogin: () => void }) {
  if (h.error) return <div className="banner error">Last hunt ({time(h.startedAt)}, {TRIGGER[h.trigger]}) failed: {h.error}</div>;
  const skipped = Object.entries(h.skipped).sort((a, b) => b[1] - a[1]);
  const skippedN = skipped.reduce((n, [, v]) => n + v, 0);
  return (
    <div className={h.loginNeeded ? 'banner error' : 'banner info'}>
      <b>Last hunt</b> {time(h.finishedAt)} · {TRIGGER[h.trigger]}: found <b>{h.found}</b> · skipped <b title={skipped.map(([k, v]) => `${k}: ${v}`).join('\n')}>{skippedN}</b>
      {skipped.length > 0 && <span className="muted"> ({skipped.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}{skipped.length > 4 ? ', …' : ''})</span>} · ready for review <b>{h.readyForReview}</b> · auto-submitted{' '}
      <b>{h.autoSubmitted}</b> · failed <b>{h.failed}</b>
      {h.loginNeeded && (
        <div>
          <b>The Drushim login expired:</b> this hunt was discovery-only.{' '}
          <button className="link" onClick={onLogin}>
            Open the login window
          </button>{' '}
          and log in again.
        </div>
      )}
    </div>
  );
}

interface ScheduleView {
  enabled: boolean;
  times: string[];
  days: number[];
  quietHours: { from: string; to: string };
  toast: boolean;
  runnable: string[];
  inQuiet: string[];
  next: string | null;
}
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** Settings card: the in-app schedule (off by default), quiet hours, the toast, and the Windows Task Scheduler option. */
export function ScheduleCard({ onSaved }: { onSaved?: () => void }) {
  const [s, setS] = useState<ScheduleView | null>(null);
  const [times, setTimes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    const r = (await (await fetch('/api/schedule')).json()) as ScheduleView;
    setS(r);
    setTimes(r.times.join(', '));
  };
  useEffect(() => {
    void load();
  }, []);
  if (!s) return null;
  const save = async (patch: Partial<ScheduleView>) => {
    const r = await fetch('/api/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    if (!r.ok) return setMsg(((await r.json()) as { error?: string }).error ?? 'not saved');
    setS((await r.json()) as ScheduleView);
    setMsg('saved');
    onSaved?.();
  };
  return (
    <fieldset className="card">
      <legend>Schedule</legend>
      <label className="row">
        <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} /> <b>Run a hunt automatically while JobHunter is running</b>
      </label>
      <p className="muted">
        A hunt = discover → score → prepare plans. It sends applications only if auto-submit is on and its gate passes. Next:{' '}
        {s.enabled ? (s.next ? new Date(s.next).toLocaleString('he-IL') : 'none (no time outside quiet hours)') : 'off'}
      </p>
      <div className="row">
        <label>
          Times (HH:MM, comma-separated){' '}
          <input value={times} onChange={(e) => setTimes(e.target.value)} style={{ width: 160 }} />
        </label>
        <button
          onClick={() =>
            void save({
              times: times
                .split(/[,\s]+/)
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        >
          Save times
        </button>
        {s.inQuiet.length > 0 && <span className="note">inside quiet hours, never run: {s.inQuiet.join(', ')}</span>}
      </div>
      <div className="row" dir="rtl">
        {DAYS.map((d, i) => (
          <label key={d}>
            <input type="checkbox" checked={s.days.includes(i)} onChange={(e) => void save({ days: e.target.checked ? [...s.days, i] : s.days.filter((x) => x !== i) })} /> {d}
          </label>
        ))}
      </div>
      <div className="row">
        <label>
          Quiet hours: no hunt starts from{' '}
          <input type="time" value={s.quietHours.from} onChange={(e) => void save({ quietHours: { ...s.quietHours, from: e.target.value } })} />
        </label>
        <label>
          to <input type="time" value={s.quietHours.to} onChange={(e) => void save({ quietHours: { ...s.quietHours, to: e.target.value } })} />
        </label>
        <label>
          <input type="checkbox" checked={s.toast} onChange={(e) => void save({ toast: e.target.checked })} /> Windows notification when a hunt ends
        </label>
        {msg && <span className="note">{msg}</span>}
      </div>
      <p className="muted">
        Also when the dashboard is closed: <code>npm run schedule:install</code> shows a Windows Task Scheduler task for these times, and asks before creating it. It runs
        only while you are logged in to Windows (it needs your Chrome profile). Remove it with <code>npm run schedule:remove</code>. Use one of the two, not both: if the
        app is open, the scheduled task hands its hunt to the running app.
      </p>
    </fieldset>
  );
}
