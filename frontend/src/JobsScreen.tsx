import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, STATUSES, type JobItem, type Status } from './api';
import { RankBadge } from './RankBadge';

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('he-IL') : '');

export function JobsScreen({
  refreshKey,
  sites,
  roleTypes = [],
  applyDisabled = false,
  linkedinEnabled = false,
}: {
  refreshKey: number;
  sites: Status['sites'];
  roleTypes?: Status['roleTypes'];
  applyDisabled?: boolean;
  linkedinEnabled?: boolean;
}) {
  const [filters, setFilters] = useState({ site: '', status: '', minScore: '', q: '', roleType: '' });
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
          {linkedinEnabled && <option value="linkedin">LinkedIn (alerts)</option>}
        </select>
        <select value={filters.status} onChange={set('status')}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={filters.roleType} onChange={set('roleType')}>
          <option value="">All role types</option>
          {roleTypes.map((r) => (
            <option key={r.id} value={r.id}>
              T{r.tier} · {r.label}
              {r.enabled ? '' : ' (disabled)'}
            </option>
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
            <th title="rank = score + experience boost + tier boost">Rank</th>
            <th>Title</th>
            <th>Role</th>
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
                  <RankBadge rank={j.rank} />
                </td>
                <td dir="auto" className="title">
                  {j.title}
                  {j.site === 'linkedin' && !j.descriptionText && <span className="badge warn" title="from a LinkedIn alert email: title, company and location only"> incomplete info</span>}
                </td>
                <td className="muted" title={j.roleTypes.join(', ')}>
                  {j.rank.roleType ?? '—'}
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
                  {j.status.startsWith('skipped') ? (
                    <button className="link" onClick={() => act(() => api.unskip(j.id))}>
                      unskip
                    </button>
                  ) : (
                    <>
                      {j.site === 'linkedin' ? (
                        <span className="muted" title="LinkedIn is assisted-only: apply yourself from the LinkedIn screen">by hand</span>
                      ) : (
                        <button className="link" disabled={applyDisabled || ['queued', 'needs_review', 'dry_run_ok', 'submitted'].includes(j.status)} title='prepare an application plan (opens the apply panel, never submits)' onClick={() => act(() => api.apply(j.id))}>
                          apply
                        </button>
                      )}
                      <button className="link" onClick={() => act(() => api.skip(j.id))}>
                        skip
                      </button>
                    </>
                  )}
                </td>
              </tr>
              {open === j.id && (
                <tr className="detail">
                  <td colSpan={10}>
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
        <div className="exp-row" dir="auto">
          <b>Required experience:</b>{' '}
          {job.requiredYears !== null ? (
            <>
              {job.requiredYears} years <span className="badge">{job.requiredYearsSource}</span> <q dir="auto">{job.requiredYearsText}</q>
            </>
          ) : (
            <span className="muted">not stated</span>
          )}
          {job.juniorText && (
            <div className="muted" dir="auto">
              junior signal: “{job.juniorText}”
            </div>
          )}
          <div className="muted">
            rank {job.rank.rank ?? '–'} = score {job.rank.score ?? '–'} · experience {job.rank.experience >= 0 ? '+' : ''}
            {job.rank.experience} ({job.rank.category}) · tier {job.rank.tier >= 0 ? '+' : ''}
            {job.rank.tier} · role {job.rank.roleType ?? '—'} · found by {job.roleTypes.join(', ') || '—'}
          </div>
        </div>
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
