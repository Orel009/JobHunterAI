import { useCallback, useEffect, useState } from 'react';
import { llm, type LlmSettings, type TaskCfg, type UsageReport } from './api';
import { Field, Num } from './forms';
import { LinkedInSettingsCard } from './LinkedInScreen';
import { AutoSubmitCard } from './AutoSubmit';
import { ScheduleCard } from './Schedule';
import type { Status } from './api';

const TASKS = [
  { id: 'analyze', label: 'Analyze', hint: 'scoring, matching, classification, CV extraction — many calls, needs reliable JSON' },
  { id: 'write', label: 'Write', hint: 'cover notes and free-text answers — few calls, quality matters' },
] as const;

/** Pick a provider + model for one task, with model suggestions from the provider's list endpoint and a connection test. */
export function TaskPicker({
  label,
  hint,
  value,
  providers,
  onChange,
}: {
  label: string;
  hint?: string;
  value: TaskCfg;
  providers: LlmSettings['providers'];
  onChange: (v: TaskCfg) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const listId = `models-${label}`;

  useEffect(() => {
    let live = true;
    setModels([]);
    setModelsError(null);
    llm
      .models(value.provider)
      .then((r) => {
        if (!live) return;
        setModels(r.models);
        setModelsError(r.error ?? null);
      })
      .catch((e: Error) => live && setModelsError(e.message));
    return () => {
      live = false;
    };
  }, [value.provider]);

  const runTest = async () => {
    setTest('testing…');
    try {
      const r = await llm.test(value.provider, value.model);
      setTest(r.ok ? `✓ works (${(r.ms / 1000).toFixed(1)} s)` : `✗ ${r.error ?? 'no valid answer'}`);
    } catch (e) {
      setTest(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <fieldset className="card">
      <legend>{label}</legend>
      {hint && <p className="muted">{hint}</p>}
      <div className="row">
        <Field label="Provider">
          <select value={value.provider} onChange={(e) => onChange({ provider: e.target.value, model: '' })}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model" hint={modelsError ? `no suggestions: ${modelsError}` : models.length ? `${models.length} models available` : undefined}>
          <input list={listId} value={value.model} placeholder="model id" onChange={(e) => onChange({ ...value, model: e.target.value.trim() })} />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <button disabled={!value.model} onClick={() => void runTest()}>
          Test connection
        </button>
        {test && <span className={test.startsWith('✓') ? 'badge ok' : test.startsWith('✗') ? 'badge warn' : 'badge'}>{test}</span>}
      </div>
    </fieldset>
  );
}

export function PrivacyNotice({ providers, labels }: { providers: string[]; labels: Record<string, string> }) {
  const cloud = providers.filter((p) => p !== 'ollama' && p !== 'fake');
  if (!cloud.length) return null;
  return (
    <div className="banner warn">
      <div dir="rtl">
        לתשומת לבך: עם ספק ענן ({cloud.map((p) => labels[p] ?? p).join(', ')}) תיאורי המשרות, פרטי הפרופיל וקורות החיים שלך נשלחים לשרתי הספק לעיבוד, וחלים עליהם תנאי
        הפרטיות שלו. עם Ollama הכול נשאר במחשב הזה.
      </div>
      <div>
        Privacy: with a cloud provider ({cloud.map((p) => labels[p] ?? p).join(', ')}) job descriptions, your profile facts and your CV text are sent to that provider for
        processing under its data policy. With Ollama everything stays on this computer.
      </div>
    </div>
  );
}

/** Write-only API key inputs: the current key is only ever shown masked. */
export function KeyInputs({ settings, only, onSaved }: { settings: LlmSettings; only?: string[]; onSaved: (s: LlmSettings) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (keys: Record<string, string | null>) => {
    try {
      onSaved(await llm.save({ keys }));
      setDraft({});
      setMsg('saved to .env');
    } catch (e) {
      setMsg(`not saved: ${(e as Error).message}`);
    }
  };
  const providers = settings.providers.filter((p) => p.needsKey && (!only || only.includes(p.id)));
  if (!providers.length) return null;
  return (
    <fieldset className="card">
      <legend>API keys</legend>
      <p className="muted">Stored only in your local .env file. Never saved in the database, never logged, never shown again in full.</p>
      {providers.map((p) => (
        <div className="row" key={p.id}>
          <Field label={p.label} hint={settings.keys[p.id] ? `current: ${settings.keys[p.id]}` : 'not set'}>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings.keys[p.id] ? 'enter a new key to replace it' : 'paste key'}
              value={draft[p.id] ?? ''}
              onChange={(e) => setDraft({ ...draft, [p.id]: e.target.value.trim() })}
            />
          </Field>
          <button disabled={!draft[p.id]} onClick={() => void save({ [p.id]: draft[p.id] ?? null })}>
            Save key
          </button>
          {settings.keys[p.id] && (
            <button className="link" onClick={() => void save({ [p.id]: null })}>
              remove
            </button>
          )}
        </div>
      ))}
      {msg && <span className="muted">{msg}</span>}
    </fieldset>
  );
}

export function SettingsScreen({ onSaved, sites = [] }: { onSaved?: () => void; sites?: Status['sites'] }) {
  const [s, setS] = useState<LlmSettings | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskCfg>>({});
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const [prices, setPrices] = useState<LlmSettings['prices']>({});
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const st = await llm.settings();
    setS(st);
    setTasks({ analyze: st.analyze, write: st.write });
    setLimit(st.dailyTokenLimit || undefined);
    setPrices(st.prices);
    setUsage(await llm.usage());
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => setMsg(e.message));
  }, [load]);

  if (!s) return <div className="card">{msg ?? 'loading…'}</div>;
  const labels = Object.fromEntries(s.providers.map((p) => [p.id, p.label]));

  const save = async () => {
    try {
      for (const t of TASKS) if (!tasks[t.id]?.model) throw new Error(`choose a model for ${t.label}`);
      const st = await llm.save({ analyze: tasks.analyze, write: tasks.write, dailyTokenLimit: limit ?? 0, prices });
      setS(st);
      setMsg('saved — applies immediately');
      onSaved?.();
    } catch (e) {
      setMsg(`not saved: ${(e as Error).message}`);
    }
  };

  // price rows: every non-local provider:model in use or seen in the usage table
  const priceKeys = [
    ...new Set([
      ...Object.values(tasks)
        .filter((t) => t.provider !== 'ollama' && t.provider !== 'fake' && t.model)
        .map((t) => `${t.provider}:${t.model}`),
      ...(usage?.rows ?? []).filter((r) => r.provider !== 'ollama' && r.provider !== 'fake').map((r) => `${r.provider}:${r.model}`),
      ...Object.keys(prices),
    ]),
  ];
  const byDay = Object.entries(
    (usage?.rows ?? []).reduce<Record<string, { tokens: number; cost: number | null; calls: number }>>((acc, r) => {
      const d = (acc[r.day] ??= { tokens: 0, cost: null, calls: 0 });
      d.tokens += r.input_tokens + r.output_tokens;
      d.calls += r.calls;
      if (r.cost !== null) d.cost = (d.cost ?? 0) + r.cost;
      return acc;
    }, {}),
  );
  const month = byDay.reduce((a, [, d]) => ({ tokens: a.tokens + d.tokens, cost: d.cost === null ? a.cost : (a.cost ?? 0) + d.cost }), { tokens: 0, cost: null as number | null });

  return (
    <div className="editor">
      <h2>Settings — language model</h2>
      <PrivacyNotice providers={Object.values(tasks).map((t) => t.provider)} labels={labels} />
      {TASKS.map((t) => (
        <TaskPicker key={t.id} label={t.label} hint={t.hint} value={tasks[t.id] ?? { provider: 'ollama', model: '' }} providers={s.providers} onChange={(v) => setTasks({ ...tasks, [t.id]: v })} />
      ))}
      <KeyInputs settings={s} onSaved={setS} />
      <fieldset className="card">
        <legend>Daily limit and prices</legend>
        <Field label="Daily token limit for API providers (0 = none)" hint="when reached, LLM steps pause until tomorrow; local Ollama is never limited">
          <Num value={limit} min={0} step={10000} onChange={setLimit} />
        </Field>
        <p className="muted">Prices in USD per 1M tokens, used only for the cost estimate. Copy them from your provider's pricing page; nothing is built in.</p>
        <table>
          <thead>
            <tr>
              <th>provider:model</th>
              <th>input $/1M</th>
              <th>output $/1M</th>
            </tr>
          </thead>
          <tbody>
            {priceKeys.map((k) => (
              <tr key={k}>
                <td>{k}</td>
                {(['input', 'output'] as const).map((side) => (
                  <td key={side}>
                    <Num
                      value={prices[k]?.[side]}
                      min={0}
                      step={0.01}
                      onChange={(v) => {
                        const cur = prices[k] ?? { input: 0, output: 0 };
                        setPrices({ ...prices, [k]: { ...cur, [side]: v ?? 0 } });
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
            {!priceKeys.length && (
              <tr>
                <td colSpan={3} className="muted">
                  no API models in use
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </fieldset>
      <div className="row">
        <button className="primary" onClick={() => void save()}>
          Save settings
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {usage && (
        <fieldset className="card">
          <legend>Usage</legend>
          <p>
            Today: {usage.today.tokens.toLocaleString()} tokens ({usage.today.apiTokens.toLocaleString()} via API
            {usage.limit ? ` of ${usage.limit.toLocaleString()} allowed` : ''}){usage.today.cost !== null && ` · ≈ $${usage.today.cost.toFixed(3)}`}
          </p>
          <p>
            Last 30 days: {month.tokens.toLocaleString()} tokens{month.cost !== null && ` · ≈ $${month.cost.toFixed(2)}`}
          </p>
          <table>
            <thead>
              <tr>
                <th>day</th>
                <th>provider:model</th>
                <th>calls</th>
                <th>input</th>
                <th>output</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={`${r.day}${r.provider}${r.model}`}>
                  <td>{r.day}</td>
                  <td>
                    {r.provider}:{r.model}
                  </td>
                  <td>{r.calls}</td>
                  <td>{r.input_tokens.toLocaleString()}</td>
                  <td>{r.output_tokens.toLocaleString()}</td>
                  <td>{r.cost === null ? (r.provider === 'ollama' ? 'free' : 'no price') : `$${r.cost.toFixed(3)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>
      )}
      <AutoSubmitCard sites={sites} onSaved={onSaved} />
      <ScheduleCard onSaved={onSaved} />
      <LinkedInSettingsCard onSaved={onSaved} />
    </div>
  );
}
