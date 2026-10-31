import { useCallback, useEffect, useState } from 'react';
import { market, type MarketBucket, type MarketReport } from './api';
import type { Prefs } from './PreferencesEditor';

const ils = (n: number) => `${n.toLocaleString('en-US')} ₪`;

/** Posted salaries of discovered jobs. A suggested floor is only a proposal: it is saved after you confirm it. */
export function MarketScreen({ onSaved }: { onSaved?: () => void }) {
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [r, setR] = useState<MarketReport | null>(null);
  const [proposal, setProposal] = useState<MarketBucket | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setR(await market(days));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);

  const confirmFloor = async (b: MarketBucket) => {
    setMsg(null);
    try {
      const cur = (await (await fetch('/api/preferences')).json()) as { preferences: Prefs };
      const prefs = cur.preferences;
      const role = prefs.roleTypes.find((x) => x.id === b.roleType);
      if (!role) throw new Error(`no role type "${b.roleType}" in your preferences`);
      role.salary = { ...(role.salary ?? {}), floor: b.suggestedFloor };
      const res = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferences: prefs }) });
      const j = (await res.json()) as { error?: string; refilter?: { newlySkipped: number } };
      if (!res.ok) throw new Error(j.error ?? 'not saved');
      setMsg(`floor for ${b.roleType} set to ${ils(b.suggestedFloor)} · ${j.refilter?.newlySkipped ?? 0} job(s) now skipped_salary or otherwise filtered`);
      setProposal(null);
      onSaved?.();
      await load();
    } catch (e) {
      setMsg(`not saved: ${(e as Error).message}`);
    }
  };

  return (
    <section className="editor market">
      <h2>Market — posted salaries</h2>
      <p className="muted">
        Monthly gross ₪ as posted in the jobs JobHunter has discovered (any status), one value per job: the middle of its posted range. Jobs with only an hourly rate are
        counted separately. Role type = the one the job is ranked as; years = the experience the post requires. “~” bucket values from search cards are approximate.
      </p>
      <div className="filters">
        {([30, 60, 90] as const).map((d) => (
          <button key={d} className={days === d ? '' : 'secondary'} onClick={() => setDays(d)}>
            last {d} days
          </button>
        ))}
        {r && (
          <span className="muted">
            {r.jobsInWindow} jobs in the window · {r.withMonthlySalary} with a posted monthly salary · {r.hourlyOnly} hourly only
          </span>
        )}
        {msg && <span className="note">{msg}</span>}
      </div>
      {r && r.buckets.length === 0 && <p className="muted">No posted salaries in this window yet.</p>}
      {r && r.buckets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Role type</th>
              <th>Required years</th>
              <th>Jobs</th>
              <th>p25</th>
              <th>Median</th>
              <th>p75</th>
              <th>Min</th>
              <th>Max</th>
              <th>Your floor</th>
              <th>Below your floor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.buckets.map((b) => (
              <tr key={`${b.roleType}|${b.years}`} className={b.years === 'all' ? 'row open' : 'row'}>
                <td>{b.years === 'all' ? <b>{b.roleType}</b> : ''}</td>
                <td>{b.years === 'all' ? 'all' : b.years}</td>
                <td>
                  {b.count}
                  {b.lowSample && (
                    <span className="badge warn" title="fewer than 10 jobs: these numbers can swing a lot">
                      {' '}
                      small sample
                    </span>
                  )}
                </td>
                <td>{ils(b.p25)}</td>
                <td>{ils(b.median)}</td>
                <td>{ils(b.p75)}</td>
                <td>{ils(b.min)}</td>
                <td>{ils(b.max)}</td>
                <td>{b.floor === null ? <span className="muted">not set</span> : ils(b.floor)}</td>
                <td>{b.belowFloorPct === null ? '—' : `${b.belowFloorPct}%`}</td>
                <td>
                  {b.roleType !== '(no role type)' && (
                    <button className="link" onClick={() => setProposal(b)}>
                      suggest floor
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {proposal && (
        <div className="banner warn">
          Proposed floor for <b>{proposal.roleType}</b>: <b>{ils(proposal.suggestedFloor)}</b> — the 25th percentile of {proposal.count} posted salaries (
          {proposal.years === 'all' ? 'all required-years levels' : `required years ${proposal.years}`}, last {days} days), rounded to 500.
          {proposal.lowSample && <b> Only {proposal.count} jobs — a small sample.</b>} Jobs posting less than the floor will be skipped (skipped_salary).{' '}
          <button className="primary" onClick={() => void confirmFloor(proposal)}>
            Set this floor
          </button>{' '}
          <button className="secondary" onClick={() => setProposal(null)}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
