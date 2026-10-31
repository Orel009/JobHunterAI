/** Small form helpers shared by the editors. */
import type { ReactNode } from 'react';

export const lines = (v: string[] | undefined) => (v ?? []).join('\n');
export const fromLines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
export const commas = (v: string[] | undefined) => (v ?? []).join(', ');
export const fromCommas = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted">{hint}</span>}
    </label>
  );
}

export function TextList({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) {
  return <textarea dir="auto" rows={rows} placeholder={placeholder ?? 'one per line'} defaultValue={lines(value)} onBlur={(e) => onChange(fromLines(e.target.value))} />;
}

export function Num({ value, onChange, step = 1, min, max }: { value: number | undefined | null; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number }) {
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

export function Issues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <div className="banner error">
      <b>Not valid:</b>
      <ul>
        {issues.slice(0, 20).map((i) => (
          <li key={i} dir="auto">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
