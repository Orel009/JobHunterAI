import { Fragment, useCallback, useEffect, useState } from 'react';

const OUTCOMES = ['no_response', 'screening_call', 'interview', 'home_assignment', 'offer', 'rejected', 'withdrawn'] as const;
type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_LABEL: Record<Outcome, string> = {
  no_response: 'no response',
  screening_call: 'screening call',
  interview: 'interview',
  home_assignment: 'home assignment',
  offer: 'offer',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
};

interface Entry {
  jobId: string;
  applicationId: number | null;
  kind: 'submitted' | 'submitted_manual';
  appliedAt: string;
  site: string;
  company: string;
  title: string;
  url: string;
  roleType: string | null;
  cv: { lang: 'he' | 'en'; cvName: string } | null;
  score: number | null;
  rank: number | null;
  evidence: { before: string | null; after: string | null; plan: string | null; response: string | null; confirmation: string | null };
  autoGate: { auto: true; at: string; conditions: Array<{ name: string; ok: boolean; detail: string }> } | null;
  outcome: Outcome;
  outcomeOn: string | null;
  outcomes: Array<{ id: number; outcome: Outcome; changedOn: string; note: string | null }>;
  notes: string;
}
interface Rate {
  key: string;
  applications: number;
  responded: number;
  rate: number;
}
interface Stats {
  total: number;
  responded: number;
  perWeek: Array<{ week: string; applications: number }>;
  byRoleType: Rate[];
  bySite: Rate[];
}

const today = () => new Date().toISOString().slice(0, 10);
/** a send time in Israel: "01/11/2026, 09:21" */
const ilTime = (iso: string) =>
  new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shot = (f: string) => `/api/screenshots/${encodeURIComponent(f)}`;

function RateTable({ title, rows }: { title: string; rows: Rate[] }) {
  return (
    <table className="helper-table">
      <thead>
        <tr>
          <th>{title}</th>
          <th>applied</th>
          <th>responded</th>
          <th>rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td>{r.applications}</td>
            <td>{r.responded}</td>
            <td>{r.rate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutcomeEditor({ e, onChanged }: { e: Entry; onChanged: () => void }) {
  const [outcome, setOutcome] = useState<Outcome>(e.outcome);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState(e.notes);
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    const r = await fetch(`/api/history/${e.jobId}/outcome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcome, date, note: note || null }) });
    if (!r.ok) return setMsg(((await r.json()) as { error?: string }).error ?? 'not saved');
    setNote('');
    setMsg(null);
    onChanged();
  };
  return (
    <div className="detail-grid">
      <div>
        <h4>Outcome</h4>
        <div className="row">
          <select value={outcome} onChange={(x) => setOutcome(x.target.value as Outcome)}>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
          <input type="date" value={date} onChange={(x) => setDate(x.target.value)} />
          <input dir="auto" placeholder="note (optional)" value={note} onChange={(x) => setNote(x.target.value)} />
          <button onClick={() => void add()}>Add</button>
          {msg && <span className="note">{msg}</span>}
        </div>
        <ul className="timeline">
          <li className="muted">
            {ilTime(e.appliedAt)} applied{e.kind === 'submitted_manual' ? ' (by hand)' : e.autoGate ? ' (auto-submitted)' : ''}
          </li>
          {e.outcomes.map((o) => (
            <li key={o.id}>
              {o.changedOn} <b>{OUTCOME_LABEL[o.outcome]}</b>
              {o.note && <span dir="auto"> — {o.note}</span>}{' '}
              <button className="link" title="remove this entry" onClick={() => void fetch(`/api/history/outcome/${o.id}`, { method: 'DELETE' }).then(onChanged)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <h4>Notes</h4>
        <textarea
          dir="auto"
          rows={4}
          value={notes}
          onChange={(x) => setNotes(x.target.value)}
          onBlur={() => void fetch(`/api/history/${e.jobId}/notes`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes }) })}
        />
      </div>
      <div>
        <h4>Evidence</h4>
        <ul>
          {e.evidence.before && (
            <li>
              <a href={shot(e.evidence.before)} target="_blank" rel="noreferrer">
                the filled panel before sending
              </a>
            </li>
          )}
          {e.evidence.after && (
            <li>
              <a href={shot(e.evidence.after)} target="_blank" rel="noreferrer">
                after sending (confirmation)
              </a>
            </li>
          )}
          {e.evidence.plan && (
            <li>
              <a href={shot(e.evidence.plan)} target="_blank" rel="noreferrer">
                field plan (every answer and its source)
              </a>
            </li>
          )}
          {e.evidence.response && (
            <li>
              <a href={shot(e.evidence.response)} target="_blank" rel="noreferrer">
                the site's response
              </a>
            </li>
          )}
          {!e.applicationId && <li className="muted">applied by hand: no evidence recorded</li>}
        </ul>
        {e.evidence.confirmation && (
          <p dir="auto" className="muted">
            confirmation: “{e.evidence.confirmation}”
          </p>
        )}
        {e.autoGate && (
          <>
            <h4>Auto-submit: conditions checked</h4>
            <ul>
              {e.autoGate.conditions.map((c) => (
                <li key={c.name}>
                  {c.ok ? '✓' : '✗'} {c.name}: <span className="muted">{c.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** Applications sent, with evidence, your own outcome tracking, CSV export and simple stats. */
export function HistoryScreen() {
  const [f, setF] = useState({ site: '', outcome: '', from: '', to: '' });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** by the send time: newest first (the default) or oldest first */
  const [oldestFirst, setOldestFirst] = useState(false);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();

  const load = useCallback(async () => {
    setEntries((await (await fetch(`/api/history?${qs}`)).json()) as Entry[]);
    setStats((await (await fetch(`/api/history/stats?${qs}`)).json()) as Stats);
  }, [qs]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = (k: keyof typeof f) => (x: { target: { value: string } }) => setF({ ...f, [k]: x.target.value });
  const maxWeek = Math.max(1, ...(stats?.perWeek.map((w) => w.applications) ?? [1]));

  return (
    <section className="history">
      <div className="filters">
        <select value={f.site} onChange={set('site')}>
          <option value="">All sites</option>
          {[...new Set(entries.map((e) => e.site).concat(f.site ? [f.site] : []))].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={f.outcome} onChange={set('outcome')}>
          <option value="">All outcomes</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
        <label className="muted">
          from <input type="date" value={f.from} onChange={set('from')} />
        </label>
        <label className="muted">
          to <input type="date" value={f.to} onChange={set('to')} />
        </label>
        <a className="button secondary" href={`/api/history.csv?${qs}`}>
          Export CSV
        </a>
        <span className="muted">{entries.length} applications</span>
      </div>

      {stats && stats.total > 0 && (
        <div className="detail-grid stats">
          <div>
            <h4>Applications per week (Sunday–Saturday)</h4>
            <table className="helper-table">
              <tbody>
                {stats.perWeek.map((w) => (
                  <tr key={w.week}>
                    <td>{w.week}</td>
                    <td>
                      <span className="bar" style={{ width: `${(100 * w.applications) / maxWeek}%` }} />
                    </td>
                    <td>{w.applications}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Responded: {stats.responded} of {stats.total} (screening call, interview, home assignment, offer or rejection).
            </p>
          </div>
          <div>
            <RateTable title="Role type" rows={stats.byRoleType} />
            <RateTable title="Site" rows={stats.bySite} />
          </div>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>
              <button className="link" title="sort by the send time" onClick={() => setOldestFirst((x) => !x)}>
                Applied (Israel time) {oldestFirst ? '▲' : '▼'}
              </button>
            </th>
            <th>Company</th>
            <th>Title</th>
            <th>Site</th>
            <th>CV</th>
            <th>Rank / score</th>
            <th>How</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {(oldestFirst ? [...entries].reverse() : entries).map((e) => (
            <Fragment key={e.jobId}>
              <tr className={open === e.jobId ? 'row open' : 'row'} onClick={() => setOpen(open === e.jobId ? null : e.jobId)}>
                <td title={e.appliedAt}>{ilTime(e.appliedAt)}</td>
                <td dir="auto">{e.company}</td>
                <td dir="auto">
                  <a href={e.url} target="_blank" rel="noreferrer" onClick={(x) => x.stopPropagation()}>
                    {e.title}
                  </a>
                </td>
                <td>{e.site}</td>
                <td dir="auto" className="muted">
                  {e.cv?.cvName ?? '—'}
                </td>
                <td>
                  {e.rank ?? '—'} / {e.score ?? '—'}
                </td>
                <td className="muted">{e.kind === 'submitted_manual' ? 'by hand' : e.autoGate ? 'auto' : 'approved'}</td>
                <td>
                  <span className={`pill outcome-${e.outcome}`}>{OUTCOME_LABEL[e.outcome]}</span> <span className="muted">{e.outcomeOn ?? ''}</span>
                </td>
              </tr>
              {open === e.jobId && (
                <tr className="detail">
                  <td colSpan={8}>
                    <OutcomeEditor e={e} onChanged={() => void load()} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!entries.length && (
            <tr>
              <td colSpan={8} className="muted">
                No applications sent yet{qs ? ' for these filters' : ''}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
