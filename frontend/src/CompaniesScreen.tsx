import { useCallback, useEffect, useState } from 'react';
import { companies as api, type CompaniesProgress, type Company } from './api';

const when = (iso: string) => new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Your target companies: add a careers URL or a job link → the ATS and board are detected (from the address, the page,
 * or the ATS APIs by name) and the job list is read once for the totals. Enabled companies (Greenhouse, Comeet) are read
 * by the companies run — here ("Read lists now"), in the header, and first in Run & send. Their jobs are applied to by
 * you in Assisted apply.
 */
export function CompaniesScreen({ busy, onChanged }: { busy: boolean; onChanged: () => void }) {
  const [list, setList] = useState<Company[]>([]);
  const [progress, setProgress] = useState<CompaniesProgress | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api.list();
    setList(s.companies);
    setProgress(s.progress);
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => setNote(e.message));
  }, [load, busy]);
  // live progress while the companies run is going
  useEffect(() => {
    if (!progress || progress.finishedAt) return;
    const t = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [progress, load]);

  const act = async (label: string, fn: () => Promise<{ companies: Company[]; progress?: CompaniesProgress | null }>, msg?: string) => {
    setWorking(label);
    setNote(null);
    try {
      const r = await fn();
      setList(r.companies);
      if (r.progress !== undefined) setProgress(r.progress);
      if (msg) setNote(msg);
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const describe = (r: Awaited<ReturnType<typeof api.add>>) => {
    const d = r.detected;
    if (d.supported) {
      const p = r.preview;
      return `✓ ${d.ats} (${d.board})${d.how === 'probe' ? ' — found through its public API' : ''}${p ? ` — ${p.error ? `could not read the list: ${p.error}` : `${p.total} jobs, ${p.israel} in Israel, ${p.kept} in your locations`}` : ''}`;
    }
    if (d.ats === 'unknown') return `✗ ATS not detected: ${d.evidence}`;
    return `${d.ats}${d.board ? ` (${d.board})` : ''}: ${d.board ? 'not supported yet — listed, but not read' : d.evidence}`;
  };

  const enabled = list.filter((c) => c.enabled && c.supported).length;
  const running = !!progress && !progress.finishedAt;
  const readWhyNot = busy || running ? 'a run is active — wait for it' : !enabled ? (list.length ? 'turn on at least one company (supported ATS) in the table' : 'add a company first') : null;

  return (
    <section className="companies">
      <div className="banner info">
        <div>
          Target companies: JobHunter reads their <b>public</b> job lists (Greenhouse, Comeet, SmartRecruiters), keeps the jobs in Israel and your locations, and scores them like any other
          job. Applying is done <b>by you</b> in Assisted apply (their forms have CAPTCHA). Careers pages and apply forms are never opened by the automated browser. Lever
          and Ashby are detected but not supported yet.
        </div>
      </div>

      <fieldset className="card">
        <legend>Add a company</legend>
        <div className="row">
          <input dir="ltr" style={{ minWidth: 380 }} value={url} placeholder="careers page or job link: job-boards.greenhouse.io/…, comeet.com/jobs/…, jobs.smartrecruiters.com/…" onChange={(e) => setUrl(e.target.value)} />
          <input dir="auto" value={name} placeholder="name (helps the detection)" onChange={(e) => setName(e.target.value)} />
          <button
            disabled={!!working || url.trim().length < 8}
            onClick={() =>
              void act('add', async () => {
                setNote('detecting the ATS…');
                const r = await api.add(url.trim(), name.trim() || undefined);
                setNote(describe(r));
                setUrl('');
                setName('');
                return r;
              })
            }
          >
            Detect and add
          </button>
        </div>
        <p className="muted">
          If the careers page is built by script, JobHunter asks the ATS APIs with the company's name; if that finds nothing either, paste <b>one job link</b> from that
          company (a job-boards.greenhouse.io or comeet.com/jobs address). Companies on your excluded list are refused.
        </p>
        {note && <p className="note">{note}</p>}
      </fieldset>

      <div className="row">
        <button disabled={!!readWhyNot || !!working} title={readWhyNot ?? 'read the lists → prefilter → experience cap → score → prepare the Greenhouse answers'} onClick={() => void act('read', async () => (await api.fetch(), await api.list()))}>
          Read lists now
        </button>
        <button className="secondary" disabled={busy || running || !!working} onClick={() => void act('score', async () => (await api.score(), await api.list()))}>
          Score only
        </button>
        {readWhyNot && <span className="muted">{readWhyNot}</span>}
      </div>

      {progress && <RunSummary p={progress} />}

      <table className="edit-table">
        <thead>
          <tr>
            <th>On</th>
            <th>Company</th>
            <th>ATS</th>
            <th>Jobs</th>
            <th>Israel</th>
            <th>In your locations</th>
            <th>Last read</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id} className={c.enabled ? '' : 'disabled-row'}>
              <td>
                <input type="checkbox" checked={c.enabled} disabled={!c.supported} title={c.supported ? 'read by the companies run' : c.status} onChange={(e) => void act('toggle', () => api.update(c.id, { enabled: e.target.checked }))} />
              </td>
              <td dir="auto">
                <b>{c.name || c.board || '—'}</b>
                <div className="muted" dir="ltr">
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.url.length > 60 ? `${c.url.slice(0, 57)}…` : c.url}
                  </a>
                </div>
              </td>
              <td>
                <span className={c.supported ? 'badge ok' : 'badge'}>{c.status}</span>
                {c.board && <div className="muted">{c.board}</div>}
                {c.paused && <span className="badge warn">paused</span>}
              </td>
              <td>{c.lastCheck?.total ?? '—'}</td>
              <td>{c.lastCheck?.israel ?? '—'}</td>
              <td>{c.lastCheck?.kept ?? '—'}</td>
              <td>
                {c.lastCheck ? when(c.lastCheck.at) : 'never'}
                {c.lastCheck?.error && <div className="note">{c.lastCheck.error}</div>}
              </td>
              <td>
                <button className="link" disabled={!!working} onClick={() => void act('detect', async () => {
                  const r = await api.detect(c.id);
                  setNote(`${c.name || c.board}: ${describe(r)}`);
                  return r;
                })}>
                  re-detect
                </button>{' '}
                <button className="link" onClick={() => void act('remove', () => api.remove(c.id))}>
                  remove
                </button>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td colSpan={8} className="muted">
                No companies yet. Add a careers page or a job link above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** Live progress, then per company: read / in Israel / in your locations / skipped by reason / scored / ready. */
function RunSummary({ p }: { p: CompaniesProgress }) {
  return (
    <fieldset className="card">
      <legend>Companies run {p.finishedAt ? `— ${when(p.finishedAt)}` : '— running'}</legend>
      {!p.finishedAt && (
        <p>
          <b>{p.stage}</b>
          {p.total ? ` · ${p.done}/${p.total} companies read` : ''}
        </p>
      )}
      {p.error && <p className="note">{p.error}</p>}
      {p.companies.length > 0 && (
        <table className="edit-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Read</th>
              <th>In Israel</th>
              <th>In your locations</th>
              <th>New</th>
              <th>Skipped (by reason)</th>
              <th>Scored</th>
              <th>Waiting for scoring</th>
              <th>Answers ready / postings read</th>
              <th>Ready in Assisted apply</th>
            </tr>
          </thead>
          <tbody>
            {p.companies.map((c) => (
              <tr key={c.id}>
                <td dir="auto">
                  <b>{c.name}</b> <span className="muted">({c.ats})</span>
                  {c.error && <div className="note">{c.error}</div>}
                </td>
                <td>{c.read ?? '—'}</td>
                <td>{c.israel ?? '—'}</td>
                <td>{c.inLocations ?? '—'}</td>
                <td>{c.added}</td>
                <td>
                  {c.skipped.map((s) => (
                    <div key={s.reason} title={s.examples.join('\n')}>
                      {s.count} × {s.reason} <span className="muted">— e.g. {s.examples[0]}</span>
                    </div>
                  ))}
                  {!c.skipped.length && <span className="muted">none</span>}
                </td>
                <td>{c.scored}</td>
                <td>{c.waiting ?? 0}</td>
                <td>{c.ats === 'greenhouse' ? c.answersPrepared : c.ats === 'smartrecruiters' ? `${c.postingsRead ?? 0} postings read` : '—'}</td>
                <td>
                  <b>{c.ready}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </fieldset>
  );
}
