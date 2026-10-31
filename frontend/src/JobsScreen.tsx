import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, STATUSES, type JobItem, type Status } from './api';

const scoreClass = (s: number | undefined) => (s === undefined ? 'score none' : s >= 80 ? 'score high' : s >= 60 ? 'score mid' : 'score low');
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

export function JobsScreen({ refreshKey, sites }: { refreshKey: number; sites: Status['sites'] }) {
  const [filters, setFilters] = useState({ site: '', status: '', minScore: '', q: '' });
  const [data, setData] = useState<{ total: number; items: JobItem[] }>({ total: 0, items: [] });
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api.jobs({ ...filters, minScore: filters.minScore || undefined, limit: 300 }));
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      const r = (await fn()) as { note?: string };
      setNote(r?.note ?? null);
    } catch (e) {
      setNote((e as Error).message);
    }
    await load();
  };

  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section className="jobs">
      <div className="filters">
        <select value={filters.site} onChange={set('site')}>
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
        <select value={filters.status} onChange={set('status')}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input type="number" min={0} max={100} placeholder="min score" value={filters.minScore} onChange={set('minScore')} />
        <input dir="auto" placeholder="search title / company" value={filters.q} onChange={set('q')} />
        <button className="secondary" onClick={() => void load()}>
          Refresh
        </button>
        <span className="muted">{data.total} jobs</span>
        {note && <span className="note">{note}</span>}
      </div>

      <table>
        <thead>
          <tr>
            <th>Score</th>
            <th>Title</th>
            <th>Company</th>
            <th>Location</th>
            <th>Site</th>
            <th>Apply</th>
            <th>Status</th>
            <th>Posted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((j) => (
            <Fragment key={j.id}>
              <tr className={open === j.id ? 'row open' : 'row'} onClick={() => setOpen(open === j.id ? null : j.id)}>
                <td>
                  <span className={scoreClass(j.score?.score)}>{j.score?.score ?? '–'}</span>
                </td>
                <td dir="auto" className="title">
                  {j.title}
                </td>
                <td dir="auto">{j.company}</td>
                <td dir="auto">{j.location}</td>
                <td>{j.site}</td>
                <td className="muted">{j.applyType.replace('site_', '')}</td>
                <td>
                  <span className={`pill status-${j.status}`} title={j.statusReason ?? ''}>
                    {j.status}
                  </span>
                </td>
                <td className="muted">{fmtDate(j.postedAt)}</td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  <a href={j.url} target="_blank" rel="noreferrer">
                    open
                  </a>
                  {j.status === 'skipped' ? (
                    <button className="link" onClick={() => act(() => api.unskip(j.id))}>
                      unskip
                    </button>
                  ) : (
                    <>
                      <button className="link" disabled={j.status === 'queued' || j.status === 'submitted'} onClick={() => act(() => api.apply(j.id))}>
                        apply
                      </button>
                      <button className="link" onClick={() => act(() => api.skip(j.id))}>
                        skip
                      </button>
                    </>
                  )}
                </td>
              </tr>
              {open === j.id && (
                <tr className="detail">
                  <td colSpan={9}>
                    <JobDetail job={j} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function JobDetail({ job }: { job: JobItem }) {
  return (
    <div className="detail-grid">
      <div>
        {job.score ? (
          <>
            <p dir="rtl" className="reasoning">
              {job.score.reasoningHe}
            </p>
            <div className="chips">
              {job.score.matchedSkills.map((s) => (
                <span key={s} dir="auto" className="chip ok">
                  ✓ {s}
                </span>
              ))}
              {job.score.missingRequirements.map((s) => (
                <span key={s} dir="auto" className="chip miss">
                  ✗ {s}
                </span>
              ))}
            </div>
            <p className="muted">
              seniority: {job.score.seniorityFit} · model: {job.score.model}
            </p>
          </>
        ) : (
          <p className="muted">Not scored{job.prefilterReason && job.prefilterPass === false ? ` — prefilter: ${job.prefilterReason}` : ''}</p>
        )}
        {job.statusReason && <p className="muted">status: {job.statusReason}</p>}
        <p className="muted">
          apply: {job.applyType} → <span dir="ltr">{job.applyTarget}</span>
        </p>
      </div>
      <div dir="auto" className="post">
        <h4>תיאור</h4>
        <pre dir="auto">{job.descriptionText || '—'}</pre>
        {job.requirementsText && (
          <>
            <h4>דרישות</h4>
            <pre dir="auto">{job.requirementsText}</pre>
          </>
        )}
      </div>
    </div>
  );
}
