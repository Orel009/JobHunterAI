import { useCallback, useEffect, useState } from 'react';
import { apply, type Application, type BatchProgress, type ResolvedField, salaryLabel } from './api';
import { RankBadge } from './RankBadge';

const SOURCE_LABEL: Record<string, string> = {
  profile: 'profile',
  bank: 'answers bank',
  skill_years: 'skill years (work roles)',
  salary: 'salary rule',
  declared_experience: 'declared experience',
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [minRank, setMinRank] = useState(90);
  const [batch, setBatch] = useState<BatchProgress | null>(null);

  const load = useCallback(async () => {
    const list = await apply.list(filter);
    setItems(list);
    // drop selections that are no longer eligible (sent, edited into a draft, …)
    setSelected((cur) => new Set([...cur].filter((id) => list.some((a) => a.id === id && !a.batchBlock))));
  }, [filter]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);
  const running = !!batch && !batch.finished;
  useEffect(() => {
    void apply.batch().then(setBatch).catch(() => undefined);
    const t = setInterval(() => void apply.batch().then(setBatch).catch(() => undefined), running ? 1500 : 5000);
    return () => clearInterval(t);
  }, [running]);

  const eligible = items.filter((a) => !a.batchBlock);
  const toggle = (id: number) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectByRank = () => setSelected(new Set(eligible.filter((a) => (a.rank.rank ?? -1) >= minRank).map((a) => a.id)));
  const approveSelected = async () => {
    const ids = [...selected];
    if (!dryRun && !window.confirm(`DRY_RUN is OFF. This will REALLY submit ${ids.length} application(s), one after another. Continue?`)) return;
    await act(async () => {
      const r = await apply.approveBatch(ids);
      setSelected(new Set());
      setBatch(await apply.batch());
      if (r.refused.length) setMsg(`${r.accepted} started; ${r.refused.length} refused: ${r.refused.map((x) => `#${x.appId} ${x.reason}`).join('; ')}`);
    }, dryRun ? 'batch dry run started' : 'batch submit started');
  };

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
      <div className="filters batch-bar">
        <b>Batch approval</b>
        <span className="muted">select all with rank ≥</span>
        <input type="number" min={0} max={100} value={minRank} onChange={(e) => setMinRank(Number(e.target.value))} style={{ width: '4.5em' }} />
        <button className="secondary" disabled={running} onClick={selectByRank}>
          select
        </button>
        <button className="link" disabled={!selected.size} onClick={() => setSelected(new Set())}>
          clear
        </button>
        <button className={dryRun ? '' : 'danger'} disabled={!selected.size || busy || running || applyDisabled} onClick={() => void approveSelected()}>
          {dryRun ? `Approve selected (${selected.size}) → DRY RUN` : `Approve selected (${selected.size}) → SUBMIT`}
        </button>
        <span className="muted">
          {eligible.length} of {items.length} can be batch-approved; drafts, pending answers and flagged claims need individual review
        </span>
      </div>
      {batch && <BatchPanel batch={batch} />}
      {items.length === 0 && <p className="muted">Nothing here. Use “apply” on the Jobs screen to prepare a plan.</p>}
      {items.map((a) => (
        <AppCard key={a.id} app={a} dryRun={dryRun} busy={busy} applyDisabled={applyDisabled} act={act} selected={selected.has(a.id)} onToggle={() => toggle(a.id)} batchLocked={running} />
      ))}
    </section>
  );
}

const BATCH_ICON: Record<string, string> = { submitted: '✔', dry_run_ok: '✔', skipped: '↷', needs_review: '↩', failed: '✗', not_sent: '–' };

function BatchPanel({ batch }: { batch: BatchProgress }) {
  const sent = batch.results.filter((r) => r.status === 'submitted' || r.status === 'dry_run_ok').length;
  return (
    <div className={`banner ${batch.stoppedReason ? 'error' : 'info'}`}>
      <div>
        <b>{batch.finished ? 'Batch finished' : 'Batch running'}</b> {batch.dryRun ? '(DRY RUN — nothing is sent)' : ''} · {batch.done}/{batch.total} done · {sent} {batch.dryRun ? 'dry-run OK' : 'sent'}
        {batch.current && <span dir="auto"> · now: {batch.current}</span>}
      </div>
      {batch.stoppedReason && <div>⛔ {batch.stoppedReason}</div>}
      <ul className="batch-results">
        {batch.results.map((r) => (
          <li key={r.appId} dir="auto">
            {BATCH_ICON[r.status] ?? '•'} #{r.appId} {r.title} — {r.company}: <b>{r.status}</b> <span className="muted">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppCard({
  app,
  dryRun,
  busy,
  applyDisabled,
  act,
  selected,
  onToggle,
  batchLocked,
}: {
  app: Application;
  dryRun: boolean;
  busy: boolean;
  applyDisabled: boolean;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  selected: boolean;
  onToggle: () => void;
  batchLocked: boolean;
}) {
  const { plan, job } = app;
  const pending = plan.fields.filter((f) => f.status === 'pending').length;
  const canApprove = !busy && !applyDisabled && pending === 0 && plan.readiness !== 'blocked_no' && !!plan.cv && ['needs_review', 'dry_run_ok', 'failed'].includes(app.status);
  return (
    <div className={`app-card status-${app.status}`}>
      <div className="app-head">
        <div>
          <div className="app-title" dir="auto">
            <input
              type="checkbox"
              checked={selected}
              disabled={!!app.batchBlock || batchLocked}
              title={app.batchBlock ? `individual review needed: ${app.batchBlock}` : 'select for batch approval'}
              onChange={onToggle}
            />{' '}
            {job?.title} — <span dir="auto">{job?.company}</span>
          </div>
          <div className="muted">
            #{app.id} · {job?.site} · {job?.applyType} · {job && <span title={job.salaryText ?? ''}>salary {salaryLabel(job)} · </span>}<span className={`pill status-${app.status}`}>{app.status}</span> · {READINESS[plan.readiness]}
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
        <RankBadge rank={app.rank} />
      </div>
      {app.score && (
        <p dir="rtl" className="reasoning">
          {app.score.reasoningHe}
        </p>
      )}
      {app.error && <div className="banner error">{app.error}</div>}
      {app.gate && !app.gate.auto && app.gate.conditions.find((c) => c.name.startsWith('auto-submit is on'))?.ok && (
        <p className="muted">
          Auto-submit not used:{' '}
          {app.gate.conditions
            .filter((c) => !c.ok)
            .map((c) => `${c.name} (${c.detail})`)
            .join(' · ')}
        </p>
      )}
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
        {app.batchBlock && ['needs_review', 'dry_run_ok', 'failed'].includes(app.status) && <span className="muted">not for batch: {app.batchBlock}</span>}
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
