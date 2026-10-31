import { useCallback, useEffect, useState } from 'react';
import { api, type Status } from './api';
import { Controls } from './Controls';
import { JobsScreen } from './JobsScreen';
import { LogPanel } from './LogPanel';

const TABS = [
  { id: 'jobs', label: 'Jobs', enabled: true },
  { id: 'review', label: 'Review queue (Phase 2)', enabled: false },
  { id: 'answers', label: 'Answers bank (Phase 2)', enabled: false },
  { id: 'history', label: 'History (Phase 3)', enabled: false },
] as const;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('jobs');
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError(`API unreachable: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      void refresh();
      setTick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="app">
      <header>
        <h1>JobHunter</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} disabled={!t.enabled} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      {error && <div className="banner error">{error} — is `npm run dev` running?</div>}
      {status && <Controls status={status} onChange={refresh} />}
      {tab === 'jobs' && <JobsScreen refreshKey={status?.activeRun ? tick : 0} sites={status?.sites ?? []} />}
      <LogPanel />
    </div>
  );
}
