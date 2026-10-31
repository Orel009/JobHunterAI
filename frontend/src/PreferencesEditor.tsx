import { useCallback, useEffect, useState } from 'react';
import { Field, Issues, Num, TextList } from './forms';

interface RoleType {
  id: string;
  label?: string;
  tier: 1 | 2 | 3;
  enabled: boolean;
  searchOnly: boolean;
  queries: string[];
  titleKeywords: string[];
  notes?: string;
}
export interface Prefs {
  roleTypes: RoleType[];
  locations: string[];
  maxRequiredYears: number;
  filters: { includeTitleKeywords: string[]; excludeTitleKeywords: string[]; excludeSeniorityKeywords: string[]; excludeCompanies: string[]; remoteKeywords: string[] };
  ranking: { experienceBoost: Record<'junior' | 'years2' | 'years3' | 'above3' | 'unknown', number>; tierBoost: Record<'tier1' | 'tier2' | 'tier3', number> };
  thresholds: { autoSubmitMinScore?: number; matchConfidence?: number };
  limits: { maxPagesPerRun?: number; dailyApplyLimit?: number; companyCooldownDays?: number };
  cv: { he: string; en: string; englishMaxHebrewRatio?: number };
  [k: string]: unknown;
}

export function PreferencesEditor({ sections, onSaved, onDirtyChange }: { sections?: string[]; onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [p, setP] = useState<Prefs | null>(null);
  const [envRatio, setEnvRatio] = useState(0.2);
  const [path, setPath] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const show = (s: string) => !sections || sections.includes(s);

  const load = useCallback(async () => {
    const r = (await (await fetch('/api/preferences')).json()) as { preferences: Prefs; path: string; englishRatioEnv: number };
    setP(r.preferences);
    setPath(r.path);
    setEnvRatio(r.englishRatioEnv);
    setDirty(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!p) return <p className="muted">loading…</p>;

  const up = (fn: (d: Prefs) => void) => {
    const next = JSON.parse(JSON.stringify(p)) as Prefs;
    fn(next);
    setP(next);
    setDirty(true);
  };
  const save = async () => {
    setMsg(null);
    const r = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferences: p }) });
    const j = (await r.json()) as { error?: string; issues?: string[] };
    if (!r.ok) {
      setIssues(j.issues ?? []);
      setMsg(j.error ?? 'save failed');
      return;
    }
    setIssues([]);
    setMsg('saved');
    await load();
    onSaved?.();
  };

  return (
    <section className="editor">
      <div className="filters sticky">
        <span className="badge">{path}</span>
        <button disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        {dirty && <span className="note">unsaved changes</span>}
        {msg && <span className="note">{msg}</span>}
      </div>
      <Issues issues={issues} />

      {show('roles') && (
        <fieldset>
          <legend>Role types</legend>
          <p className="muted">
            Tier 1 = core, 2 = good, 3 = fallback. Queries are searched on the sites; a job counts as this role type when its title contains one of the title
            keywords (whole words). Search-only role types (e.g. junior) are searched but never decide a job's tier.
          </p>
          <table className="edit-table">
            <thead>
              <tr>
                <th>On</th>
                <th>Id / label</th>
                <th>Tier</th>
                <th>Search only</th>
                <th>Queries (one per line)</th>
                <th>Title keywords (one per line)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.roleTypes.map((r, i) => (
                <tr key={`${r.id}-${i}`} className={r.enabled ? '' : 'disabled-row'}>
                  <td>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => up((d) => void (d.roleTypes[i]!.enabled = e.target.checked))} />
                  </td>
                  <td>
                    <input value={r.id} onChange={(e) => up((d) => void (d.roleTypes[i]!.id = e.target.value))} />
                    <input placeholder="label" value={r.label ?? ''} onChange={(e) => up((d) => void (d.roleTypes[i]!.label = e.target.value || undefined))} />
                    <input placeholder="notes for the scorer" value={r.notes ?? ''} onChange={(e) => up((d) => void (d.roleTypes[i]!.notes = e.target.value || undefined))} />
                  </td>
                  <td>
                    <select value={r.tier} onChange={(e) => up((d) => void (d.roleTypes[i]!.tier = Number(e.target.value) as 1 | 2 | 3))}>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                    </select>
                  </td>
                  <td>
                    <input type="checkbox" checked={!!r.searchOnly} onChange={(e) => up((d) => void (d.roleTypes[i]!.searchOnly = e.target.checked))} />
                  </td>
                  <td>
                    <TextList value={r.queries} rows={4} onChange={(v) => up((d) => void (d.roleTypes[i]!.queries = v))} />
                  </td>
                  <td>
                    <TextList value={r.titleKeywords} rows={4} onChange={(v) => up((d) => void (d.roleTypes[i]!.titleKeywords = v))} />
                  </td>
                  <td>
                    <button className="link" onClick={() => up((d) => void d.roleTypes.splice(i, 1))}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="secondary" onClick={() => up((d) => d.roleTypes.push({ id: `role${d.roleTypes.length + 1}`, tier: 2, enabled: true, searchOnly: false, queries: [], titleKeywords: [] }))}>
            + add role type
          </button>
        </fieldset>
      )}

      {show('where') && (
        <fieldset>
          <legend>Where & how senior</legend>
          <div className="grid3">
            <Field label="Locations (city or region, one per line)">
              <TextList value={p.locations} rows={8} onChange={(v) => up((d) => void (d.locations = v))} />
            </Field>
            <Field label="Always-OK location words (remote / hybrid…)">
              <TextList value={p.filters.remoteKeywords} rows={4} onChange={(v) => up((d) => void (d.filters.remoteKeywords = v))} />
            </Field>
            <Field label="Max required years of experience" hint="jobs requiring more are skipped (skipped_experience)">
              <Num value={p.maxRequiredYears} min={0} step={0.5} onChange={(v) => up((d) => void (d.maxRequiredYears = v ?? 0))} />
            </Field>
          </div>
        </fieldset>
      )}

      {show('keywords') && (
        <fieldset>
          <legend>Title keywords (whole words, case-insensitive)</legend>
          <div className="grid3">
            <Field label="Extra include keywords">
              <TextList value={p.filters.includeTitleKeywords} onChange={(v) => up((d) => void (d.filters.includeTitleKeywords = v))} />
            </Field>
            <Field label="Exclude keywords">
              <TextList value={p.filters.excludeTitleKeywords} rows={6} onChange={(v) => up((d) => void (d.filters.excludeTitleKeywords = v))} />
            </Field>
            <Field label="Seniority excludes (list each form: בכיר + בכירה)">
              <TextList value={p.filters.excludeSeniorityKeywords} rows={6} onChange={(v) => up((d) => void (d.filters.excludeSeniorityKeywords = v))} />
            </Field>
            <Field label="Excluded companies">
              <TextList value={p.filters.excludeCompanies} onChange={(v) => up((d) => void (d.filters.excludeCompanies = v))} />
            </Field>
          </div>
        </fieldset>
      )}

      {show('ranking') && (
        <fieldset>
          <legend>Ranking (rank = score + experience boost + tier boost) · thresholds · limits</legend>
          <div className="grid4">
            {(['junior', 'years2', 'years3', 'above3', 'unknown'] as const).map((k) => (
              <Field key={k} label={`experience: ${k}`}>
                <Num value={p.ranking.experienceBoost[k]} onChange={(v) => up((d) => void (d.ranking.experienceBoost[k] = v ?? 0))} />
              </Field>
            ))}
            {(['tier1', 'tier2', 'tier3'] as const).map((k) => (
              <Field key={k} label={`tier boost: ${k}`}>
                <Num value={p.ranking.tierBoost[k]} onChange={(v) => up((d) => void (d.ranking.tierBoost[k] = v ?? 0))} />
              </Field>
            ))}
            <Field label="Prepare plans for score ≥ (--hunt)">
              <Num value={p.thresholds.autoSubmitMinScore} min={0} max={100} onChange={(v) => up((d) => void (d.thresholds.autoSubmitMinScore = v))} />
            </Field>
            <Field label="Answers-bank match confidence">
              <Num value={p.thresholds.matchConfidence} min={0} max={1} step={0.05} onChange={(v) => up((d) => void (d.thresholds.matchConfidence = v))} />
            </Field>
            <Field label="Pages per search">
              <Num value={p.limits.maxPagesPerRun} min={1} onChange={(v) => up((d) => void (d.limits.maxPagesPerRun = v))} />
            </Field>
            <Field label="Daily apply limit">
              <Num value={p.limits.dailyApplyLimit} min={0} onChange={(v) => up((d) => void (d.limits.dailyApplyLimit = v))} />
            </Field>
            <Field label="Company cooldown (days)">
              <Num value={p.limits.companyCooldownDays} min={0} onChange={(v) => up((d) => void (d.limits.companyCooldownDays = v))} />
            </Field>
          </div>
        </fieldset>
      )}

      {show('cv') && (
        <fieldset>
          <legend>CVs on Drushim</legend>
          <p className="muted">Names exactly as they appear in your Drushim account's CV list. The application sends the CV stored there.</p>
          <div className="grid3">
            <Field label="Hebrew CV name">
              <input dir="auto" value={p.cv.he} onChange={(e) => up((d) => void (d.cv.he = e.target.value))} />
            </Field>
            <Field label="English CV name">
              <input dir="auto" value={p.cv.en} onChange={(e) => up((d) => void (d.cv.en = e.target.value))} />
            </Field>
            <Field label="English CV when Hebrew letters are below" hint={`share of the post's letters (default ${envRatio})`}>
              <Num value={p.cv.englishMaxHebrewRatio ?? envRatio} min={0} max={1} step={0.05} onChange={(v) => up((d) => void (d.cv.englishMaxHebrewRatio = v))} />
            </Field>
          </div>
        </fieldset>
      )}
    </section>
  );
}
