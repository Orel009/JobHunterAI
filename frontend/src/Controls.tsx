import { useEffect, useState } from 'react';
import { api, linkedin, type RunRow, type Status } from './api';
import { HuntSummaryLine } from './Schedule';

export function Controls({ status, onChange, profileReady = true }: { status: Status; onChange: () => void; profileReady?: boolean }) {
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
        <span className={status.sessions.drushim?.state === 'logged_in' ? 'badge ok' : status.sessions.drushim?.state === 'logged_out' ? 'badge warn' : 'badge'} title={status.sessions.drushim?.detail}>
          Drushim: {status.sessions.drushim?.state === 'logged_in' ? 'logged in' : status.sessions.drushim?.state === 'logged_out' ? 'NOT logged in' : 'login unknown'}
        </span>
        <button className="link" disabled={!!run || busy} onClick={() => act(api.checkSession)}>
          re-check login
        </button>
        <span className={status.pendingQuestions ? 'badge warn' : 'badge'}>pending answers: {status.pendingQuestions}</span>
        <LlmBadge llm={status.llm} />
        {Object.entries(status.counts).map(([k, v]) => (
          <span key={k} className={`badge status-${k}`}>
            {k}: {v}
          </span>
        ))}
      </div>

      <div className="runbar">
        {status.sites.map((s) => (
          <span key={s.id} className="site-actions">
            <button
              disabled={!s.enabled || !!run || busy}
              onClick={() => act(() => api.startRun(s.id, 'full'))}
              title={profileReady ? 'search → prefilter → details → score' : 'search → prefilter → details; scoring is skipped until your profile is approved, then starts by itself'}
            >
              Discover {s.displayName}
            </button>
            {s.enabled && (
              <button className="secondary" disabled={!!run || busy} onClick={() => act(() => api.startRun(s.id, 'score'))}>
                Score only
              </button>
            )}
          </span>
        ))}
        {!profileReady && <span className="note">no approved profile: Discover finds jobs, scoring waits for the profile</span>}
        <button
          className="secondary"
          disabled={!!run || busy || status.huntRunning}
          title="one full hunt: discover → score → prepare plans (sends only if auto-submit is on and its gate passes)"
          onClick={() => act(() => fetch('/api/hunt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(((await r.json()) as { error?: string }).error)))))}
        >
          {status.huntRunning ? 'Hunt running…' : 'Run hunt now'}
        </button>
        {status.schedule.enabled && status.schedule.next && <span className="muted">next scheduled hunt {new Date(status.schedule.next).toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
        {status.linkedin.enabled && (
          <button disabled={!!run || busy} onClick={() => act(linkedin.fetch)} title="read new LinkedIn job-alert emails → prefilter → score (LinkedIn itself is never opened)">
            Fetch LinkedIn alerts
          </button>
        )}
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
            {lastRun.stats.waitingForProfile ? ` · ${lastRun.stats.waitingForProfile} waiting for the profile` : ''}
          </span>
        )}
      </div>
      {msg && <div className="banner error">{msg}</div>}
      {status.lastHunt && (
        <HuntSummaryLine h={status.lastHunt} onLogin={() => void fetch('/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })} />
      )}
    </section>
  );
}

function LlmBadge({ llm }: { llm: Status['llm'] }) {
  const label = (t: { provider: string; model: string }) => `${t.provider}:${t.model || '?'}`;
  const same = llm.analyze.provider === llm.write.provider && llm.analyze.model === llm.write.model;
  const text = same ? label(llm.analyze) : `analyze ${label(llm.analyze)} · write ${label(llm.write)}`;
  const paused = llm.tokenLimit > 0 && llm.tokensToday >= llm.tokenLimit;
  const problem = paused ? 'paused: daily token limit' : llm.ollama && !llm.ollama.ok ? 'Ollama offline' : llm.ollama?.missing.length ? `not pulled: ${llm.ollama.missing.join(', ')}` : null;
  return (
    <span className={problem ? 'badge warn' : 'badge ok'} title={llm.cloud ? `API tokens today: ${llm.tokensToday.toLocaleString()}${llm.tokenLimit ? ` / ${llm.tokenLimit.toLocaleString()}` : ''}` : 'local model'}>
      LLM: {text}
      {problem && ` — ${problem}`}
      {llm.cloud && !problem && ` · ${llm.tokensToday.toLocaleString()} tokens today`}
    </span>
  );
}
