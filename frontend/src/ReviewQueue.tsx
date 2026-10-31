import { useCallback, useEffect, useState } from 'react';
import { apply, type Application, type ResolvedField } from './api';

const SOURCE_LABEL: Record<string, string> = {
  profile: 'profile',
  bank: 'answers bank',
  skill_years: 'skill years',
  draft: 'LLM draft',
  user: 'you (this job only)',
  none: '—',
};
const READINESS: Record<string, string> = {
  ready: 'ready',
  needs_answers: 'needs your answers',
  has_drafts: 'has drafts — review the text',
  blocked_no: 'a required statement is false',
};
const OPEN = 'needs_review,approved,dry_run_ok,failed';

export function ReviewQueue({ dryRun, busy, applyDisabled = false, onChanged }: { dryRun: boolean; busy: boolean; applyDisabled?: boolean; onChanged: () => void }) {
  const [items, setItems] = useState<Application[]>([]);
  const [filter, setFilter] = useState(OPEN);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => setItems(await apply.list(filter)), [filter]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    }
    await load();
    onChanged();
  };

  return (
    <section className="review">
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value={OPEN}>Open (needs review / dry run / failed)</option>
          <option value="needs_review">Needs review</option>
          <option value="dry_run_ok">Dry run OK</option>
          <option value="submitted">Submitted</option>
          <option value="skipped,rejected">Skipped / rejected</option>
          <option value="">All</option>
        </select>
        <button className="secondary" disabled={busy || applyDisabled} onClick={() => act(apply.prepareQueued, 'preparing queued jobs…')}>
          Prepare queued
        </button>
        <span className="muted">{items.length} applications</span>
        {msg && <span className="note">{msg}</span>}
      </div>
      {items.length === 0 && <p className="muted">Nothing here. Use “apply” on the Jobs screen to prepare a plan.</p>}
      {items.map((a) => (
        <AppCard key={a.id} app={a} dryRun={dryRun} busy={busy} applyDisabled={applyDisabled} act={act} />
      ))}
    </section>
  );
}

function AppCard({ app, dryRun, busy, applyDisabled, act }: { app: Application; dryRun: boolean; busy: boolean; applyDisabled: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const { plan, job } = app;
  const pending = plan.fields.filter((f) => f.status === 'pending').length;
  const canApprove = !busy && !applyDisabled && pending === 0 && plan.readiness !== 'blocked_no' && !!plan.cv && ['needs_review', 'dry_run_ok', 'failed'].includes(app.status);
  return (
    <div className={`app-card status-${app.status}`}>
      <div className="app-head">
        <div>
          <div className="app-title" dir="auto">
            {job?.title} — <span dir="auto">{job?.company}</span>
          </div>
          <div className="muted">
            #{app.id} · {job?.site} · {job?.applyType} · <span className={`pill status-${app.status}`}>{app.status}</span> · {READINESS[plan.readiness]}
            {job && (
              <>
                {' '}
                ·{' '}
                <a href={job.url} target="_blank" rel="noreferrer">
                  open post
                </a>
              </>
            )}
          </div>
        </div>
        {app.score && <span className={`score ${app.score.score >= 80 ? 'high' : app.score.score >= 60 ? 'mid' : 'low'}`}>{app.score.score}</span>}
      </div>
      {app.score && (
        <p dir="rtl" className="reasoning">
          {app.score.reasoningHe}
        </p>
      )}
      {app.error && <div className="banner error">{app.error}</div>}
      {plan.notes.map((n) => (
        <div key={n} className="muted" dir="auto">
          ℹ {n}
        </div>
      ))}

      {plan.cv && (
        <div className="cv-row">
          <b>CV:</b> <span dir="auto">{plan.cv.cvName}</span> <span className="badge">{plan.cv.lang === 'he' ? 'Hebrew' : 'English'}</span>
          <span className="muted">
            {' '}
            Hebrew letters {(plan.cv.hebrewRatio * 100).toFixed(0)}% (English CV below {(plan.cv.threshold * 100).toFixed(0)}%){plan.cv.overridden ? ' · overridden by you' : ''}
          </span>
          <button className="link" onClick={() => act(() => apply.setCv(app.id, plan.cv!.lang === 'he' ? 'en' : 'he'))}>
            switch to {plan.cv.lang === 'he' ? 'English' : 'Hebrew'}
          </button>
        </div>
      )}

      <table className="plan">
        <thead>
          <tr>
            <th>Question / field</th>
            <th>Answer</th>
            <th>Provenance</th>
          </tr>
        </thead>
        <tbody>
          {plan.fields.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No form fields (one-click apply: CV only).
              </td>
            </tr>
          )}
          {plan.fields.map((f) => (
            <FieldRow key={f.field.key} appId={app.id} f={f} act={act} />
          ))}
        </tbody>
      </table>

      <div className="shots">
        {app.screenshotBefore && (
          <a href={apply.screenshotUrl(app.screenshotBefore)} target="_blank" rel="noreferrer">
            <img src={apply.screenshotUrl(app.screenshotBefore)} alt="before submit" />
            <div className="muted">before final click</div>
          </a>
        )}
        {app.screenshotAfter && (
          <a href={apply.screenshotUrl(app.screenshotAfter)} target="_blank" rel="noreferrer">
            <img src={apply.screenshotUrl(app.screenshotAfter)} alt="after submit" />
            <div className="muted">after submit</div>
          </a>
        )}
        {app.confirmationText && (
          <div className="confirm" dir="auto">
            ✔ {app.confirmationText}
          </div>
        )}
      </div>

      <div className="actions-row">
        <button
          className={dryRun ? '' : 'danger'}
          disabled={!canApprove}
          title={pending ? 'answer the pending questions first' : ''}
          onClick={() => {
            if (!dryRun && !window.confirm('DRY_RUN is OFF. This will REALLY submit the application. Continue?')) return;
            void act(() => apply.approve(app.id), dryRun ? 'dry run started' : 'submitting…');
          }}
        >
          {dryRun ? 'Approve → DRY RUN (no submit)' : 'Approve → SUBMIT for real'}
        </button>
        <button className="secondary" disabled={busy || app.status === 'submitted'} onClick={() => act(() => apply.reject(app.id), 'rejected')}>
          Reject / skip job
        </button>
        {pending > 0 && <span className="note">{pending} pending answer(s)</span>}
      </div>
    </div>
  );
}

function FieldRow({ appId, f, act }: { appId: number; f: ResolvedField; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(f.status === 'pending');
  const [value, setValue] = useState(f.value ?? '');
  const [save, setSave] = useState(true);
  const yn = f.field.type === 'yes_no' || f.field.type === 'consent';
  const shown = yn ? (f.value === 'yes' ? 'כן' : f.value === 'no' ? 'לא' : '') : f.value;

  const submit = (v: string) => act(() => apply.editField(appId, f.field.key, v, save)).then(() => setEditing(false));

  return (
    <tr className={`field-${f.status}`}>
      <td dir="auto">
        {f.field.label}
        {f.field.required ? <span className="req"> *</span> : <span className="muted"> (optional)</span>}
        <div className="muted">{f.field.type}{f.category ? ` · ${f.category}` : ''}</div>
      </td>
      <td dir="auto">
        {!editing ? (
          <>
            {f.status === 'pending' ? <span className="pending">pending — {f.reason}</span> : <span className="answer">{shown || <i className="muted">empty</i>}</span>}
            {f.provenance.flaggedClaims && f.provenance.flaggedClaims.length > 0 && (
              <div className="flagged">⚠ unsupported claims: {f.provenance.flaggedClaims.join(' · ')}</div>
            )}
            <div>
              <button className="link" onClick={() => setEditing(true)}>
                edit
              </button>
            </div>
          </>
        ) : (
          <div className="edit">
            {yn ? (
              <span>
                <button onClick={() => submit('yes')}>כן</button> <button className="secondary" onClick={() => submit('no')}>לא</button>
              </span>
            ) : (
              <>
                {f.field.type === 'textarea' ? (
                  <textarea dir="auto" rows={4} value={value} onChange={(e) => setValue(e.target.value)} />
                ) : (
                  <input dir="auto" value={value} onChange={(e) => setValue(e.target.value)} />
                )}
                <button disabled={!value.trim()} onClick={() => submit(value)}>
                  save
                </button>
              </>
            )}
            <label className="muted">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> save to answers bank
            </label>
            {f.status !== 'pending' && (
              <button className="link" onClick={() => setEditing(false)}>
                cancel
              </button>
            )}
          </div>
        )}
      </td>
      <td>
        <span className={`prov prov-${f.provenance.source}`}>{SOURCE_LABEL[f.provenance.source]}</span>
        {f.provenance.ref && <div className="muted">ref {f.provenance.ref}</div>}
        {f.provenance.confidence !== undefined && <div className="muted">conf {f.provenance.confidence.toFixed(2)}</div>}
        {f.provenance.detail && (
          <div className="muted" dir="auto">
            {f.provenance.detail}
          </div>
        )}
        {f.provenance.usedFactIds && <div className="muted">cites {f.provenance.usedFactIds.join(', ')}</div>}
      </td>
    </tr>
  );
}
