import { useCallback, useEffect, useState } from 'react';
import { companies as api, type Company } from './api';

const when = (iso: string) => new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Your target companies: add a careers URL or a job link → the ATS and board are detected and the job list is read once
 * for the totals. Enabled companies (Greenhouse, Comeet) are read on every Run & send; their jobs are applied to by you in
 * the assisted panel.
 */
export function CompaniesScreen({ busy, onChanged }: { busy: boolean; onChanged: () => void }) {
  const [list, setList] = useState<Company[]>([]);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => setList((await api.list()).companies), []);
  useEffect(() => {
    void load().catch((e: Error) => setNote(e.message));
  }, [load, busy]);

  const act = async (fn: () => Promise<{ companies: Company[] }>, msg?: string) => {
    setNote(null);
    try {
      setList((await fn()).companies);
      if (msg) setNote(msg);
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const add = async () => {
    setAdding(true);
    setNote('detecting the ATS and reading the job list once…');
    try {
      const r = await api.add(url.trim(), name.trim() || undefined);
      setList(r.companies);
      const d = r.detected;
      setNote(
        d.supported
          ? `✓ ${d.ats} (${d.board})${r.preview ? ` — ${r.preview.error ? `could not read the list: ${r.preview.error}` : `${r.preview.total} jobs, ${r.preview.israel} in Israel, ${r.preview.kept} in your locations`}` : ''}`
          : d.ats === 'unknown'
            ? `✗ ATS not detected: ${d.evidence}`
            : `${d.ats}${d.board ? ` (${d.board})` : ''}: ${d.board ? 'not supported yet — listed, but not read' : d.evidence}`,
      );
      setUrl('');
      setName('');
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="companies">
      <div className="banner info">
        <div>
          Target companies: JobHunter reads their <b>public</b> job lists (Greenhouse, Comeet) once per Run & send, keeps the jobs in your locations, and scores them like any
          other job. Applying is done <b>by you</b> in the assisted panel (their forms have CAPTCHA). Careers pages and apply forms are never opened by the automated browser.
          Lever and Ashby are detected but not supported yet.
        </div>
      </div>

      <fieldset className="card">
        <legend>Add a company</legend>
        <div className="row">
          <input dir="ltr" style={{ minWidth: 380 }} value={url} placeholder="careers page or job link, e.g. https://job-boards.greenhouse.io/… or https://www.comeet.com/jobs/…" onChange={(e) => setUrl(e.target.value)} />
          <input dir="auto" value={name} placeholder="name (optional)" onChange={(e) => setName(e.target.value)} />
          <button disabled={adding || url.trim().length < 8} onClick={() => void add()}>
            Detect and add
          </button>
          <button className="secondary" disabled={busy || !list.some((c) => c.enabled)} onClick={() => void act(async () => (await api.fetch(), await api.list()), 'reading the enabled companies now…')}>
            Read lists now
          </button>
        </div>
        <p className="muted">
          A careers page that is built by script shows no ATS link: paste one job link from that company instead (a job-boards.greenhouse.io or comeet.com/jobs address).
        </p>
        {note && <p className="note">{note}</p>}
      </fieldset>

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
                <input
                  type="checkbox"
                  checked={c.enabled}
                  disabled={!c.supported}
                  title={c.supported ? 'read on every Run & send' : c.status}
                  onChange={(e) => void act(() => api.update(c.id, { enabled: e.target.checked }))}
                />
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
                <button className="link" onClick={() => void act(() => api.remove(c.id))}>
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
