import { useCallback, useEffect, useState } from 'react';
import { api, linkedin, type ApplyHelper, type HelperItem, type JobItem, type LinkedInSettings } from './api';
import { Field, Num } from './forms';
import { RankBadge } from './RankBadge';

/** Settings card: the optional email job alerts (LinkedIn, Indeed; off by default), each source, and the IMAP connection. */
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
      setTest(`✓ connected — ${Object.entries(r.bySource ?? {}).map(([k, v]) => `${v} ${SOURCE_LABEL[k] ?? k}`).join(', ') || r.alerts} alert email(s) in ${r.mailbox} from the last ${r.windowDays} days`);
    } catch (e) {
      setTest(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <fieldset className="card">
      <legend>Email job alerts (optional)</legend>
      <label>
        <input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? 'turned on' : 'turned off — imported jobs are kept')} />{' '}
        <b>Enable email job alerts</b>
      </label>
      <p className="muted">
        Reads the job-alert emails LinkedIn and Indeed send you (from your mailbox, read-only) and adds those jobs to the list. JobHunter never logs in to LinkedIn or Indeed,
        never opens them in its automated browser and never clicks anything there: you apply yourself, in your own browser, with a helper panel. Off = no mail connection at all.
      </p>
      {s.enabled && (
        <>
          <div className="row">
            <b>Sources:</b>
            {(['linkedin', 'indeed'] as const).map((k) => (
              <label key={k}>
                <input type="checkbox" checked={s.sources[k]} onChange={(e) => void save({ sources: { [k]: e.target.checked } }, `${SOURCE_LABEL[k]} alerts ${e.target.checked ? 'on' : 'off'}`)} /> {SOURCE_LABEL[k]}
              </label>
            ))}
            <span className="muted">
              Indeed: a link to a Drushim job joins the normal Drushim flow; a company / ATS link goes to the review queue; Indeed Apply is applied to by hand here.
            </span>
          </div>
          <div className="grid2">
            <Field label="Email address" hint="the mailbox that receives the job alerts (Gmail)">
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

/** Greenhouse: the application form's own questions, answered ahead (pending ones: answer them in the answers bank). */
function FormAnswersTable({ form }: { form: NonNullable<ApplyHelper['form']> }) {
  if (form.error) return <p className="note">Application form questions: {form.error}</p>;
  const pending = form.answers.filter((a) => a.status === 'pending');
  return (
    <>
      <h4>Application form (Greenhouse){pending.length ? ` — ${pending.length} pending` : ''}</h4>
      <table className="helper-table">
        <tbody>
          {form.answers.map((a, i) =>
            a.status === 'resolved' && a.value ? (
              <CopyRow key={i} item={{ label: `${a.label}${a.required ? ' *' : ''}`, value: a.value, source: a.source }} />
            ) : (
              <tr key={i}>
                <td dir="auto">
                  {a.label}
                  {a.required ? ' *' : ''}
                </td>
                <td className="muted" colSpan={2}>
                  {a.status === 'pending' ? `pending — ${a.source} (Answers bank)` : 'optional — left empty'}
                  {a.options?.length ? ` · options: ${a.options.join(' / ')}` : ''}
                </td>
              </tr>
            ),
          )}
          {!form.answers.length && (
            <tr>
              <td className="muted">The form asks only for the CV and your details.</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
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

const TODO = ['discovered', 'scored', 'queued', 'needs_review', 'needs_manual'];
const SOURCE_LABEL: Record<string, string> = { linkedin: 'LinkedIn', indeed: 'Indeed', drushim: 'Drushim', jobmaster: 'JobMaster', jobnet: 'Jobnet', jobkarov: 'JobKarov', greenhouse: 'Greenhouse', comeet: 'Comeet', smartrecruiters: 'SmartRecruiters' };
const ASSISTED = ['linkedin', 'indeed'];

/**
 * Assisted apply: jobs from alert emails (LinkedIn, Indeed), and jobs a site's send left for you (needs_manual, e.g. a
 * JobKarov CAPTCHA). Open in your own browser, apply yourself with the helper, then mark it.
 */
export function LinkedInScreen({
  busy,
  onChanged,
  sources = ['linkedin'],
  alertsOn = true,
  openJobId = null,
  onOpened,
}: {
  busy: boolean;
  onChanged: () => void;
  sources?: string[];
  alertsOn?: boolean;
  /** a job to open (from the Jobs list) */
  openJobId?: string | null;
  onOpened?: () => void;
}) {
  const [view, setView] = useState<'todo' | 'applied' | 'all'>('todo');
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [sel, setSel] = useState<JobItem | null>(null);
  const [helper, setHelper] = useState<ApplyHelper | null>(null);
  const [desc, setDesc] = useState('');
  const [ext, setExt] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const lists = await Promise.all([...sources.map((site) => api.jobs({ site, limit: 500 })), api.jobs({ status: 'needs_manual', limit: 500 })]);
    const seen = new Set<string>();
    const items = lists
      .flatMap((r) => r.items)
      .filter((j) => !seen.has(j.id) && !!seen.add(j.id)).sort((a, b) => (b.rank.rank ?? -1) - (a.rank.rank ?? -1));
    setJobs(items);
    setSel((cur) => (cur ? (items.find((j) => j.id === cur.id) ?? null) : null));
  }, [sources.join(',')]);
  useEffect(() => {
    void load();
  }, [load, busy]);
  // opened from the Jobs list: select it, in "All" when it is not in To do
  useEffect(() => {
    if (!openJobId) return;
    const j = jobs.find((x) => x.id === openJobId);
    if (!j) return;
    if (!TODO.includes(j.status)) setView('all');
    setSel(j);
    onOpened?.();
  }, [openJobId, jobs]);
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
          LinkedIn ו-Indeed בעזרה בלבד: המערכת לא מתחברת אליהם ולא לוחצת שם על שום דבר, כדי לא לסכן את החשבון. פותחים את המשרה בדפדפן הרגיל, מגישים ידנית בעזרת הנתונים
          שכאן, ומסמנים "I applied". אין לסמן או להצהיר על שום דבר שאינו נכון.
        </div>
        <div>
          LinkedIn and Indeed are assisted-only: JobHunter never logs in to them or clicks anything there (to keep your accounts safe). Open the job in your own browser, apply
          yourself with the details below, then click “I applied”. Never tick or state anything that isn't true.
        </div>
        {jobs.some((j) => j.site === 'greenhouse' || j.site === 'comeet' || j.site === 'smartrecruiters') && (
          <div>
            Company jobs (Greenhouse / Comeet / SmartRecruiters, from the Companies screen) are applied to by you on the company's form: open it in your browser, attach the CV and copy the
            answers below. For Greenhouse jobs the form's questions are read once and answered ahead from your profile and answers bank.
          </div>
        )}
        {jobs.some((j) => j.status === 'needs_manual') && (
          <div>
            “By hand” jobs: the site asked for a CAPTCHA when JobHunter sent the application, so nothing was sent (a CAPTCHA is never attempted). Apply to them yourself the
            same way. On JobKarov, answer “לא” to “send my CV to similar jobs” and leave “קצת על עצמי” empty.
          </div>
        )}
      </div>
      <div className="filters">
        {(['todo', 'applied', 'all'] as const).map((v) => (
          <button key={v} className={view === v ? '' : 'secondary'} onClick={() => setView(v)}>
            {v === 'todo' ? 'To do' : v === 'applied' ? 'Applied' : 'All'}
          </button>
        ))}
        {alertsOn && (
          <button disabled={busy} onClick={() => void act(linkedin.fetch)}>
            Fetch alerts now
          </button>
        )}
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
                  <div className="title">
                    {j.title} <span className="badge">{SOURCE_LABEL[j.site] ?? j.site}</span>
                  </div>
                  <div className="muted">
                    {j.company} · {j.location}
                  </div>
                  {j.status === 'needs_manual' && <span className="badge warn" title={j.statusReason ?? ''}>{j.statusReason === 'captcha' ? 'CAPTCHA — apply by hand' : 'apply by hand'}</span>}
                  {j.applyTarget && ASSISTED.includes(j.site) && <span className="badge ok" title={j.applyTarget}>company link → review queue</span>}
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
                <td className="muted">No jobs from alert emails here yet. Alerts are read when you click “Fetch alerts now” (and on every Run & send).</td>
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
              {SOURCE_LABEL[sel.site] ?? sel.site} · {sel.location} · <span className={`pill status-${sel.status}`}>{sel.status}</span>
            </p>
            {helper?.links && helper.links.length > 1 && (
              <p className="muted">
                Also on:{' '}
                {helper.links
                  .filter((l) => l.jobId !== sel.id)
                  .map((l) => (
                    <a key={l.jobId} href={l.url} target="_blank" rel="noreferrer" style={{ marginInlineEnd: 8 }}>
                      {SOURCE_LABEL[l.site] ?? l.site}
                    </a>
                  ))}
              </p>
            )}
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

            {ASSISTED.includes(sel.site) && (!sel.descriptionText || desc) && (
              <div className="card">
                <b>Incomplete info:</b> the alert email has only the title, company and location, so the score is a rough guess. Paste the job description from the job page
                to score it properly.
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
                {helper.form && <FormAnswersTable form={helper.form} />}
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

            {ASSISTED.includes(sel.site) && (
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
            )}
          </div>
        )}
      </div>
    </section>
  );
}
