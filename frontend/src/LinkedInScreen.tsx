import { useCallback, useEffect, useState } from 'react';
import { api, linkedin, type ApplyHelper, type HelperItem, type JobItem, type LinkedInSettings } from './api';
import { Field, Num } from './forms';
import { RankBadge } from './RankBadge';

/** Settings card: the optional LinkedIn job-alert feature (off by default) and its IMAP connection. */
export function LinkedInSettingsCard({ onSaved }: { onSaved?: () => void }) {
  const [s, setS] = useState<LinkedInSettings | null>(null);
  const [form, setForm] = useState({ user: '', host: '', port: 993, mailbox: '', windowDays: 14 });
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const apply = (st: LinkedInSettings) => {
    setS(st);
    setForm({ user: st.imap.user, host: st.imap.host, port: st.imap.port, mailbox: st.mailbox, windowDays: st.windowDays });
  };
  useEffect(() => {
    void linkedin.settings().then(apply).catch((e: Error) => setMsg(e.message));
  }, []);
  if (!s) return null;

  const save = async (patch: Parameters<typeof linkedin.save>[0], note: string) => {
    try {
      apply(await linkedin.save(patch));
      setMsg(note);
      setTest(null);
      onSaved?.();
    } catch (e) {
      setMsg(`not saved: ${(e as Error).message}`);
    }
  };
  const runTest = async () => {
    setTest('connecting…');
    try {
      const r = await linkedin.test();
      setTest(`✓ connected — ${r.alerts} LinkedIn alert email(s) in ${r.mailbox} from the last ${r.windowDays} days`);
    } catch (e) {
      setTest(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <fieldset className="card">
      <legend>LinkedIn job alerts (optional)</legend>
      <label>
        <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'turned on' : 'turned off — imported LinkedIn jobs are kept')} />{' '}
        <b>Enable LinkedIn job alerts (email)</b>
      </label>
      <p className="muted">
        Reads the job-alert emails LinkedIn sends you (from your mailbox, read-only) and adds those jobs to the list. JobHunter never logs in to LinkedIn, never opens it in its
        automated browser and never clicks anything there: you apply yourself, in your own browser, with a helper panel. Off = no mail connection at all.
      </p>
      {s.enabled && (
        <>
          <div className="grid2">
            <Field label="Email address" hint="the mailbox that receives the LinkedIn alerts (Gmail)">
              <input value={form.user} autoComplete="off" onChange={(e) => setForm({ ...form, user: e.target.value })} />
            </Field>
            <Field label="App password" hint={s.imap.password ? `current: ${s.imap.password} — stored only in .env` : 'Gmail: Google Account → Security → App passwords. Stored only in .env'}>
              <input type="password" autoComplete="off" value={password} placeholder={s.imap.password ? 'enter a new one to replace it' : '16 letters'} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="IMAP server">
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </Field>
            <Field label="Port">
              <Num value={form.port} min={1} onChange={(v) => setForm({ ...form, port: v ?? 993 })} />
            </Field>
            <Field label="Mailbox / label" hint="INBOX, or the Gmail label your alerts are filtered into">
              <input value={form.mailbox} onChange={(e) => setForm({ ...form, mailbox: e.target.value })} />
            </Field>
            <Field label="Read alerts from the last N days">
              <Num value={form.windowDays} min={1} onChange={(v) => setForm({ ...form, windowDays: v ?? 14 })} />
            </Field>
          </div>
          <div className="row">
            <button
              onClick={() =>
                void save({ user: form.user, host: form.host, port: form.port, mailbox: form.mailbox, windowDays: form.windowDays, ...(password ? { password } : {}) }, 'saved').then(() =>
                  setPassword(''),
                )
              }
            >
              Save
            </button>
            <button disabled={!s.configured} title={s.configured ? undefined : 'save the email address and app password first'} onClick={() => void runTest()}>
              Test connection
            </button>
            {s.imap.password && (
              <button className="link" onClick={() => void save({ password: null }, 'app password removed')}>
                remove app password
              </button>
            )}
            {test && <span className={test.startsWith('✓') ? 'badge ok' : test.startsWith('✗') ? 'badge warn' : 'badge'}>{test}</span>}
          </div>
        </>
      )}
      {msg && <span className="muted">{msg}</span>}
    </fieldset>
  );
}

function CopyRow({ item }: { item: HelperItem }) {
  const [done, setDone] = useState(false);
  return (
    <tr>
      <td dir="auto">{item.label}</td>
      <td dir="auto">
        <b>{item.value}</b>
      </td>
      <td>
        <button
          className="link"
          onClick={() =>
            void navigator.clipboard.writeText(item.value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            })
          }
        >
          {done ? 'copied ✓' : 'copy'}
        </button>
      </td>
      <td className="muted">{item.source}</td>
    </tr>
  );
}

function HelperTable({ title, items }: { title: string; items: HelperItem[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <table className="helper-table">
        <tbody>
          {items.map((i) => (
            <CopyRow key={`${i.label}${i.source}`} item={i} />
          ))}
        </tbody>
      </table>
    </>
  );
}

const TODO = ['discovered', 'scored', 'queued', 'needs_review'];

/** Assisted apply for LinkedIn jobs: open in your own browser, apply yourself with the helper, then mark it. */
export function LinkedInScreen({ busy, onChanged }: { busy: boolean; onChanged: () => void }) {
  const [view, setView] = useState<'todo' | 'applied' | 'all'>('todo');
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [sel, setSel] = useState<JobItem | null>(null);
  const [helper, setHelper] = useState<ApplyHelper | null>(null);
  const [desc, setDesc] = useState('');
  const [ext, setExt] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.jobs({ site: 'linkedin', limit: 500 });
    setJobs(r.items);
    setSel((cur) => (cur ? (r.items.find((j) => j.id === cur.id) ?? null) : null));
  }, []);
  useEffect(() => {
    void load();
  }, [load, busy]);
  useEffect(() => {
    setHelper(null);
    setDesc('');
    setExt('');
    if (sel) void linkedin.helper(sel.id).then(setHelper).catch((e: Error) => setNote(e.message));
  }, [sel?.id, sel?.descriptionText]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setNote(null);
    try {
      const r = (await fn()) as { note?: string } | undefined;
      if (r?.note) setNote(r.note);
      after?.();
    } catch (e) {
      setNote((e as Error).message);
    }
    await load();
    onChanged();
  };

  const shown = jobs.filter((j) => (view === 'all' ? true : view === 'applied' ? j.status === 'submitted_manual' : TODO.includes(j.status)));

  return (
    <section className="linkedin">
      <div className="banner info">
        <div dir="rtl">
          LinkedIn בעזרה בלבד: המערכת לא מתחברת ל-LinkedIn ולא לוחצת שם על שום דבר, כדי לא לסכן את החשבון. פותחים את המשרה בדפדפן הרגיל, מגישים ידנית בעזרת הנתונים
          שכאן, ומסמנים "I applied". אין לסמן או להצהיר על שום דבר שאינו נכון.
        </div>
        <div>
          LinkedIn is assisted-only: JobHunter never logs in to LinkedIn or clicks anything there (to keep your account safe). Open the job in your own browser, apply yourself with
          the details below, then click “I applied”. Never tick or state anything that isn't true.
        </div>
      </div>
      <div className="filters">
        {(['todo', 'applied', 'all'] as const).map((v) => (
          <button key={v} className={view === v ? '' : 'secondary'} onClick={() => setView(v)}>
            {v === 'todo' ? 'To do' : v === 'applied' ? 'Applied' : 'All'}
          </button>
        ))}
        <button disabled={busy} onClick={() => void act(linkedin.fetch)}>
          Fetch alerts now
        </button>
        <span className="muted">{shown.length} jobs</span>
        {note && <span className="note">{note}</span>}
      </div>
      <div className="li-grid">
        <table>
          <tbody>
            {shown.map((j) => (
              <tr key={j.id} className={sel?.id === j.id ? 'row open' : 'row'} onClick={() => setSel(j)}>
                <td>
                  <RankBadge rank={j.rank} />
                </td>
                <td dir="auto">
                  <div className="title">{j.title}</div>
                  <div className="muted">
                    {j.company} · {j.location}
                  </div>
                  {!j.descriptionText && <span className="badge warn">incomplete info</span>}
                </td>
                <td>
                  <span className={`pill status-${j.status}`} title={j.statusReason ?? ''}>
                    {j.status}
                  </span>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td className="muted">No LinkedIn jobs here yet. Alerts are read when you click “Fetch alerts now” (and on every --hunt).</td>
              </tr>
            )}
          </tbody>
        </table>

        {sel && (
          <div className="card li-panel">
            <h3 dir="auto">
              {sel.title} <span className="muted">— {sel.company}</span>
            </h3>
            <p className="muted" dir="auto">
              {sel.location} · <span className={`pill status-${sel.status}`}>{sel.status}</span>
            </p>
            {sel.score && (
              <p dir="rtl" className="reasoning">
                {sel.score.reasoningHe}
              </p>
            )}
            <div className="row">
              <button className="primary" onClick={() => void act(() => linkedin.open(sel.id))}>
                Open in my browser
              </button>
              <button disabled={sel.status === 'submitted_manual'} onClick={() => void act(() => linkedin.applied(sel.id))}>
                I applied
              </button>
              <button className="secondary" onClick={() => void act(() => linkedin.skip(sel.id))}>
                Skip
              </button>
            </div>

            {(!sel.descriptionText || desc) && (
              <div className="card">
                <b>Incomplete info:</b> the alert email has only the title, company and location, so the score is a rough guess. Paste the job description from LinkedIn to score
                it properly.
                <textarea dir="auto" rows={5} value={desc} placeholder="paste the full job description here" onChange={(e) => setDesc(e.target.value)} />
                <button disabled={desc.trim().length < 20 || busy} onClick={() => void act(() => linkedin.description(sel.id, desc), () => setDesc(''))}>
                  Save and re-score
                </button>
              </div>
            )}

            {helper && (
              <>
                <h4>CV to attach</h4>
                <p>
                  <b>{helper.cv.lang === 'he' ? 'Hebrew' : 'English'} CV</b> — <span dir="ltr">{helper.cv.file}</span> <span className="muted">({helper.cv.reason})</span>{' '}
                  <button className="link" disabled={!helper.cv.exists} title={helper.cv.exists ? 'opens the folder with the file selected' : 'upload it on the Profile screen first'} onClick={() => void act(() => linkedin.showCv(sel.id))}>
                    show file
                  </button>
                  {!helper.cv.exists && <span className="muted"> — not uploaded yet (Profile screen)</span>}
                </p>
                <HelperTable title="Your details" items={helper.contact} />
                {helper.declared && (
                  <HelperTable
                    title="Declared experience (only for general “years of development” questions)"
                    items={[{ label: 'Total years of development', value: String(helper.declared.totalDevYears), source: `declared — ${helper.declared.basis}` }]}
                  />
                )}
                <HelperTable title="Years per skill (from your work roles)" items={helper.skillYears} />
                <HelperTable title="Salary expectation (upper half of the posted range; else your fallback; empty = decide yourself)" items={helper.salary.filter((s) => s.value)} />
                {helper.salary.some((s) => !s.value) && <p className="muted">{helper.salary.find((s) => !s.value)!.source}</p>}
                <HelperTable title="Answers bank" items={helper.answers} />
                {!helper.contact.length && !helper.answers.length && <p className="muted">No profile or saved answers yet.</p>}
              </>
            )}

            <div className="card">
              <b>“Apply on company website”?</b> Paste that link: a Drushim job joins the normal flow (prepare → your approval); any other site goes to the review queue
              with the link.
              <div className="row">
                <input dir="ltr" value={ext} placeholder="https://…" onChange={(e) => setExt(e.target.value)} />
                <button disabled={!ext.trim()} onClick={() => void act(() => linkedin.external(sel.id, ext.trim()), () => setExt(''))}>
                  Use this link
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
