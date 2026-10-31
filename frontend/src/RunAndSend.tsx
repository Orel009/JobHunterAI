import { useState } from 'react';
import type { Status } from './api';

/** The main action: one session run — discover all enabled sites → score → prepare → send what passes the gate. */
export function RunAndSendButton({ status, onChange }: { status: Status; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const busy = status.huntRunning || !!status.activeRun;
  const start = async () => {
    setErr(null);
    const r = await fetch('/api/hunt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    onChange();
  };
  return (
    <span className="run-send">
      <button
        className="primary run-send-btn"
        disabled={busy}
        title={`discover all enabled sites → score → prepare → send what passes the auto-submit gate. Sending now: ${status.sending}`}
        onClick={() => void start()}
      >
        {status.huntRunning ? '▶ Running…' : '▶ Run & send'}
      </button>
      {err && <span className="note">{err}</span>}
    </span>
  );
}

const ICON = { running: '⏳', done: '✔', skipped: '–', failed: '✗' } as const;

/** Live progress while it runs, then the "Done. Safe to close" summary. */
export function RunAndSendPanel({ status }: { status: Status }) {
  const [hidden, setHidden] = useState<number | null>(null);
  const p = status.huntProgress;
  if (!p || hidden === p.id) return null;
  const h = status.lastHunt && status.lastHunt.id === p.id ? status.lastHunt : null;
  const still = status.stillRunning;

  if (!p.finished)
    return (
      <div className="banner info run-panel">
        <b>Run & send</b> — <b>{p.step}</b>
        {p.current && (
          <span>
            {' '}
            · now: <bdi>{p.current}</bdi>
          </span>
        )}
        <ul className="steps">
          {p.steps.map((s, i) => (
            <li key={i}>
              {ICON[s.state]} {s.name}
              {s.detail && <span className="muted"> — {s.detail}</span>}
            </li>
          ))}
        </ul>
        <div>
          found {p.counts.found} · scored {p.counts.scored}
          {p.counts.candidates > 0 && ` · to prepare ${p.counts.candidates}`}
        </div>
        <div className="muted">Sending: {status.sending === 'on' ? 'on — jobs that pass the gate are sent' : status.sending}. “Pause auto-submit” stops sending at once.</div>
      </div>
    );

  const skipped = Object.entries(h?.skipped ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className={`banner ${still.length ? 'warn' : h?.error || p.step.startsWith('failed') ? 'error' : 'ok-banner'} run-panel`}>
      <div className="run-done">
        {still.length ? (
          <>
            <b>Still running:</b> {still.join(' · ')} — wait before closing.
          </>
        ) : (
          <>
            <b>Done. Safe to close / shut down.</b> <span dir="rtl">· הסתיים, אפשר לסגור ולכבות.</span>
          </>
        )}
        <button className="link" onClick={() => setHidden(p.id)}>
          hide
        </button>
      </div>
      {h?.error || p.step.startsWith('failed') ? (
        <div>The run failed: {h?.error ?? p.step}</div>
      ) : (
        h && (
          <table className="done-table">
            <tbody>
              <tr>
                <td>found</td>
                <td>
                  <b>{h.found}</b> new job(s)
                </td>
              </tr>
              <tr>
                <td>skipped</td>
                <td>
                  <b>{skipped.reduce((n, [, v]) => n + v, 0)}</b> {skipped.length > 0 && <span className="muted">({skipped.map(([k, v]) => `${k} ${v}`).join(', ')})</span>}
                </td>
              </tr>
              <tr>
                <td>sent</td>
                <td>
                  <b>{h.sent ?? h.autoSubmitted}</b> {h.sending && h.sending !== 'on' && <span className="muted">— {h.sending}</span>}
                </td>
              </tr>
              <tr>
                <td>waiting for review</td>
                <td>
                  <b>{h.waitingForReview ?? h.readyForReview}</b> <span className="muted">(Review queue → batch approval)</span>
                </td>
              </tr>
              <tr>
                <td>failed</td>
                <td>
                  <b>{h.failed}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )
      )}
      {h?.loginNeeded && <div>The Drushim login expired: this run was discovery-only. Log in again, then run again.</div>}
      {h?.note && !h.loginNeeded && <div className="muted">{h.note}</div>}
    </div>
  );
}
