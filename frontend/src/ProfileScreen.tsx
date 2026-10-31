import { useCallback, useEffect, useState } from 'react';
import { ProfileEditor } from './ProfileEditor';
import { Issues } from './forms';

type Lang = 'he' | 'en';
interface CvInfo {
  state: Partial<Record<Lang, { file: string; uploadedAt: string; history: number; needsDrushimUpdate: boolean }>>;
  job: { status: 'idle' | 'running' | 'done' | 'failed'; stage: string; pct: number; error: string | null; result: 'draft' | 'pending_update' | null };
  pending: { createdAt: string; target: 'profile' | 'draft'; count: number } | null;
  drushimCvNames: { he: string; en: string };
}
interface Entry {
  id: string;
  section: string;
  kind: 'added' | 'changed' | 'removed';
  label: string;
  before: unknown;
  after: unknown;
  safe: boolean;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v && 'he' in v && 'en' in v) return [(v as { en: string | null }).en, (v as { he: string | null }).he].filter(Boolean).join(' / ');
  const o = v as { title?: unknown; company?: unknown; institution?: unknown; start?: string; end?: string };
  if (o.title || o.institution) return `${show(o.title ?? o.institution)}${o.company ? ` @ ${show(o.company)}` : ''} (${o.start ?? '?'} – ${o.end ?? '?'})`;
  return JSON.stringify(v);
};

export function CvUploads({ onChanged, langs = ['he', 'en'] }: { onChanged?: () => void; langs?: Lang[] }) {
  const [info, setInfo] = useState<CvInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setInfo((await (await fetch('/api/profile/cv')).json()) as CvInfo), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);
  const prevStatus = info?.job.status;
  useEffect(() => {
    if (prevStatus === 'done') onChanged?.();
  }, [prevStatus, onChanged]);

  const upload = async (lang: Lang, file: File) => {
    setMsg(null);
    const r = await fetch(`/api/profile/cv/${lang}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file });
    const j = (await r.json()) as { error?: string; changed?: boolean; note?: string };
    setMsg(r.ok ? (j.note ?? (j.changed ? 'uploaded — reading the CV…' : 'same file as before — reading it again…')) : (j.error ?? 'upload failed'));
    await load();
  };
  if (!info) return null;
  const running = info.job.status === 'running';
  return (
    <fieldset>
      <legend>CVs</legend>
      <div className="grid2">
        {langs.map((l) => {
          const s = info.state[l];
          return (
            <div key={l} className="cv-slot">
              <b>{l === 'he' ? 'Hebrew CV' : 'English CV'}</b> (PDF)
              <div className="muted">{s ? `last upload ${new Date(s.uploadedAt).toLocaleString('he-IL')} · ${s.history} version(s) kept` : 'not uploaded'}</div>
              <input type="file" accept="application/pdf,.pdf" disabled={running} onChange={(e) => e.target.files?.[0] && void upload(l, e.target.files[0])} />
            </div>
          );
        })}
      </div>
      {info.job.status !== 'idle' && (
        <div className="progress-row">
          <progress max={100} value={info.job.pct} /> <span className="muted">{info.job.status === 'failed' ? `failed: ${info.job.error}` : info.job.stage}</span>
        </div>
      )}
      <button className="secondary" disabled={running || !Object.keys(info.state).length} onClick={() => void fetch('/api/profile/cv/extract', { method: 'POST' }).then(load)}>
        Read the CVs again
      </button>
      {msg && <span className="note"> {msg}</span>}
    </fieldset>
  );
}

export function DiffReview({ onApplied }: { onApplied: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(async () => {
    const p = (await (await fetch('/api/profile/update')).json()) as { entries: Entry[] } | null;
    setEntries(p?.entries ?? null);
    setAccepted(new Set());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (ids: string[]) => {
    const r = await fetch('/api/profile/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: ids }) });
    const j = (await r.json()) as { error?: string; issues?: string[]; applied?: number };
    if (!r.ok) {
      setIssues(j.issues ?? [j.error ?? 'failed']);
      return;
    }
    setDone(`${j.applied} change(s) applied.`);
    setEntries(null);
    onApplied();
  };

  if (done)
    return (
      <div className="banner ok-banner">
        {done}{' '}
        <button className="secondary" onClick={() => void fetch('/api/jobs/rescore', { method: 'POST' }).then(() => setDone(`${done} Re-scoring active jobs…`))}>
          Re-score active jobs
        </button>
      </div>
    );
  if (!entries) return null;
  const toggle = (id: string) => setAccepted((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const sections = [...new Set(entries.map((e) => e.section))];
  return (
    <fieldset className="diff">
      <legend>Changes from the new CV — {entries.length}</legend>
      <p className="muted">Nothing is changed until you apply. Your skill links, levels, aliases, removed skills, declared experience, locked dates and gender are never touched.</p>
      <Issues issues={issues} />
      {sections.map((sec) => (
        <div key={sec}>
          <h4>{sec}</h4>
          {entries
            .filter((e) => e.section === sec)
            .map((e) => (
              <label key={e.id} className={`diff-row diff-${e.kind}`}>
                <input type="checkbox" checked={accepted.has(e.id)} onChange={() => toggle(e.id)} />
                <span className="pill">{e.kind}</span>
                {e.safe && <span className="pill ok">safe</span>}
                <span dir="auto">{e.label}</span>
                {e.kind === 'changed' && (
                  <span className="muted" dir="auto">
                    {' '}
                    {show(e.before)} → <b>{show(e.after)}</b>
                  </span>
                )}
              </label>
            ))}
        </div>
      ))}
      <div className="actions-row">
        <button onClick={() => void apply(entries.filter((e) => e.safe).map((e) => e.id))}>Accept all safe changes</button>
        <button className="secondary" disabled={!accepted.size} onClick={() => void apply([...accepted])}>
          Apply selected ({accepted.size})
        </button>
        <button className="link" onClick={() => void fetch('/api/profile/update', { method: 'DELETE' }).then(load)}>
          discard
        </button>
      </div>
    </fieldset>
  );
}

/** Profile screen: CV uploads + pending update review + the profile editor. */
export function ProfileScreen({ onChanged }: { onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const refresh = useCallback(() => {
    setKey((k) => k + 1);
    onChanged();
  }, [onChanged]);
  return (
    <section>
      <CvUploads onChanged={refresh} />
      <DiffReview key={`d${key}`} onApplied={refresh} />
      <ProfileEditor key={`e${key}`} onSaved={onChanged} />
    </section>
  );
}
