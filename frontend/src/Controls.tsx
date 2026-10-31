import { useEffect, useState } from 'react';
import { api, type RunRow, type Status } from './api';

export function Controls({ status, onChange }: { status: Status; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunRow | null>(null);
  const run = status.activeRun;

  useEffect(() => {
    void api.runs().then((r) => setLastRun(r[0] ?? null)).catch(() => undefined);
  }, [run?.id, run === null]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  return (
    <section className="controls">
      <div className="badges">
        <span className={status.dryRun ? 'badge dry' : 'badge live'}>{status.dryRun ? 'DRY RUN' : 'LIVE — real submissions'}</span>
        <span className="badge">
          Today: {status.today.submitted}/{status.limits.dailyApplyLimit} submitted
        </span>
        <span className={status.ollama.ok && status.ollama.analyzeAvailable ? 'badge ok' : 'badge warn'}>
          Ollama: {status.ollama.ok ? (status.ollama.analyzeAvailable ? status.models.analyze : `${status.models.analyze} not pulled`) : 'offline'}
        </span>
        {Object.entries(status.counts).map(([k, v]) => (
          <span key={k} className={`badge status-${k}`}>
            {k}: {v}
          </span>
        ))}
      </div>

      <div className="runbar">
        {status.sites.map((s) => (
          <span key={s.id} className="site-actions">
            <button disabled={!s.enabled || !!run || busy} onClick={() => act(() => api.startRun(s.id, 'full'))} title="search → prefilter → details → score">
              Discover {s.displayName}
            </button>
            {s.enabled && (
              <button className="secondary" disabled={!!run || busy} onClick={() => act(() => api.startRun(s.id, 'score'))}>
                Score only
              </button>
            )}
          </span>
        ))}
        {run && (
          <>
            <button className="danger" onClick={() => act(api.stopRun)}>
              Stop
            </button>
            <span className="run-info">
              Run #{run.id} {run.site}/{run.kind} — <b>{run.stage}</b> · seen {run.stats.seen ?? 0} · new {run.stats.inserted ?? 0} · passed{' '}
              {run.stats.prefilterPassed ?? 0} · details {run.stats.detailsFetched ?? 0} · scored {run.stats.scored ?? 0}
            </span>
          </>
        )}
        {!run && lastRun && (
          <span className={`run-info last-${lastRun.status}`}>
            Last run #{lastRun.id} {lastRun.site}: <b>{lastRun.status}</b>
            {lastRun.reason ? ` — ${lastRun.reason}` : ''} · new {lastRun.stats.inserted ?? 0} · scored {lastRun.stats.scored ?? 0}
          </span>
        )}
      </div>
      {msg && <div className="banner error">{msg}</div>}
    </section>
  );
}
