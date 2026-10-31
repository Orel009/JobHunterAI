import { useCallback, useEffect, useState } from 'react';
import { Field, Issues, Num, TextList, commas, fromCommas } from './forms';

/* Loose shapes: the server validates with the real schema on save. */
type Bi = { he: string | null; en: string | null };
interface Role {
  id: string;
  kind: string;
  company: Bi;
  title: Bi;
  start: string | null;
  end: string | null;
  skills: string[];
  highlights: { he: string[]; en: string[] };
  sources?: string[];
  datesLocked?: boolean;
}
interface Skill {
  id: string;
  name: string;
  aliases: string[];
  statedYears: number | null;
  level: 'strong' | 'basic';
  sources?: string[];
}
interface Edu {
  id: string;
  institution: Bi;
  degree: Bi;
  field: Bi;
  start: string | null;
  end: string | null;
  datesLocked?: boolean;
}
export interface ProfileDoc {
  gender: 'male' | 'female' | null;
  blockedSkills: string[];
  contact: { name: Bi; email: string | null; phone: string | null; city: Bi };
  links: Array<{ id: string; label: string; url: string }>;
  summary: Bi;
  experience: Role[];
  education: Edu[];
  skills: Skill[];
  languages: Array<{ id: string; name: Bi; level: Bi }>;
  declaredExperience: { totalDevYears: number; basis: string } | null;
  [k: string]: unknown;
}
interface Loaded {
  source: 'profile' | 'draft' | 'none';
  path?: string;
  profile: ProfileDoc | null;
  validation: { ok: boolean; issues: string[] };
  derived: { skillYears: Record<string, { years: number | null; source: string | null; from: string[] }> } | null;
}

const KINDS = ['work', 'project', 'education', 'military', 'volunteer', 'other'];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9א-ת]+/g, '-')
    .replace(/^-|-$/g, '') || 'x';
const uniq = (base: string, taken: string[]) => {
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
};
const roleLabel = (r: Role) => r.title.en || r.title.he || r.company.en || r.company.he || r.id;

export function ProfileEditor({ compact = false, sections, onSaved }: { compact?: boolean; sections?: string[]; onSaved?: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [p, setP] = useState<ProfileDoc | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const show = (s: string) => !sections || sections.includes(s);

  const load = useCallback(async () => {
    const r = (await (await fetch('/api/profile')).json()) as Loaded;
    setData(r);
    setP(r.profile ? (JSON.parse(JSON.stringify(r.profile)) as ProfileDoc) : null);
    setIssues(r.validation.issues);
    setDirty(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <p className="muted">loading…</p>;
  if (!p) return <p className="muted">No profile yet. Upload a CV on the Profile screen (or finish the setup wizard).</p>;

  const up = (fn: (d: ProfileDoc) => void) => {
    const next = JSON.parse(JSON.stringify(p)) as ProfileDoc;
    fn(next);
    next.blockedSkills ??= [];
    setP(next);
    setDirty(true);
  };

  const save = async (target?: 'profile' | 'draft') => {
    setMsg(null);
    const r = await fetch('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: p, target }) });
    const j = (await r.json()) as { error?: string; issues?: string[]; validation?: { issues: string[] }; target?: string };
    if (!r.ok) {
      setIssues(j.issues ?? []);
      setMsg(j.error ?? 'save failed');
      return;
    }
    setMsg(`saved to ${j.target === 'profile' ? 'profile.json' : 'profile.draft.json'}${j.validation?.issues.length ? ' (draft still has issues)' : ''}`);
    await load();
    onSaved?.();
  };
  const promote = async () => {
    await save('draft');
    const r = await fetch('/api/profile/promote', { method: 'POST' });
    const j = (await r.json()) as { error?: string; issues?: string[] };
    if (!r.ok) {
      setIssues(j.issues ?? []);
      setMsg(j.error ?? 'failed');
      return;
    }
    setMsg('draft approved → profile.json');
    await load();
    onSaved?.();
  };

  const removeSkill = (s: Skill) =>
    up((d) => {
      d.skills = d.skills.filter((x) => x.id !== s.id);
      for (const r of d.experience) r.skills = r.skills.filter((x) => x !== s.id);
      d.blockedSkills = [...new Set([...(d.blockedSkills ?? []), s.name, ...s.aliases])];
    });

  return (
    <section className={compact ? 'editor compact' : 'editor'}>
      <div className="filters sticky">
        <span className={`badge ${data.source === 'profile' ? 'ok' : 'warn'}`}>{data.source === 'profile' ? 'profile.json' : 'profile.draft.json (not approved yet)'}</span>
        <button disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        {data.source === 'draft' && (
          <button className="secondary" onClick={() => void promote()} title="validate and save as profile.json">
            Approve draft → profile.json
          </button>
        )}
        {dirty && <span className="note">unsaved changes</span>}
        {msg && <span className="note">{msg}</span>}
      </div>
      <Issues issues={issues} />

      {show('contact') && (
        <fieldset>
          <legend>Contact & gender</legend>
          <div className="grid4">
            <Field label="Name (Hebrew)">
              <input dir="rtl" value={p.contact.name.he ?? ''} onChange={(e) => up((d) => void (d.contact.name.he = e.target.value || null))} />
            </Field>
            <Field label="Name (English)">
              <input value={p.contact.name.en ?? ''} onChange={(e) => up((d) => void (d.contact.name.en = e.target.value || null))} />
            </Field>
            <Field label="Gender" hint="Hebrew grammatical forms in drafts">
              <select value={p.gender ?? ''} onChange={(e) => up((d) => void (d.gender = (e.target.value || null) as ProfileDoc['gender']))}>
                <option value="">— choose —</option>
                <option value="male">male / זכר</option>
                <option value="female">female / נקבה</option>
              </select>
            </Field>
            <Field label="Email">
              <input value={p.contact.email ?? ''} onChange={(e) => up((d) => void (d.contact.email = e.target.value || null))} />
            </Field>
            <Field label="Phone">
              <input value={p.contact.phone ?? ''} onChange={(e) => up((d) => void (d.contact.phone = e.target.value || null))} />
            </Field>
            <Field label="City (Hebrew)">
              <input dir="rtl" value={p.contact.city.he ?? ''} onChange={(e) => up((d) => void (d.contact.city.he = e.target.value || null))} />
            </Field>
            <Field label="City (English)">
              <input value={p.contact.city.en ?? ''} onChange={(e) => up((d) => void (d.contact.city.en = e.target.value || null))} />
            </Field>
          </div>
          {!compact && (
            <div className="grid2">
              <Field label="Summary (Hebrew)">
                <textarea dir="rtl" rows={3} value={p.summary.he ?? ''} onChange={(e) => up((d) => void (d.summary.he = e.target.value || null))} />
              </Field>
              <Field label="Summary (English)">
                <textarea rows={3} value={p.summary.en ?? ''} onChange={(e) => up((d) => void (d.summary.en = e.target.value || null))} />
              </Field>
            </div>
          )}
        </fieldset>
      )}

      {show('roles') && (
        <fieldset>
          <legend>Roles</legend>
          <p className="muted">Dates: YYYY-MM (month) or YYYY. Only kind = work counts toward years of experience. Editing dates locks them against CV updates.</p>
          <table className="edit-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Title (he / en)</th>
                <th>Company (he / en)</th>
                <th>Start</th>
                <th>End</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.experience.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    <select value={r.kind} onChange={(e) => up((d) => void (d.experience[i]!.kind = e.target.value))}>
                      {KINDS.map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                    <div className="muted">{r.id}</div>
                  </td>
                  <td>
                    <input dir="rtl" value={r.title.he ?? ''} onChange={(e) => up((d) => void (d.experience[i]!.title.he = e.target.value || null))} />
                    <input value={r.title.en ?? ''} onChange={(e) => up((d) => void (d.experience[i]!.title.en = e.target.value || null))} />
                  </td>
                  <td>
                    <input dir="rtl" value={r.company.he ?? ''} onChange={(e) => up((d) => void (d.experience[i]!.company.he = e.target.value || null))} />
                    <input value={r.company.en ?? ''} onChange={(e) => up((d) => void (d.experience[i]!.company.en = e.target.value || null))} />
                  </td>
                  <td>
                    <input className="date" placeholder="YYYY-MM" value={r.start ?? ''} onChange={(e) => up((d) => void ((d.experience[i]!.start = e.target.value || null), (d.experience[i]!.datesLocked = true)))} />
                  </td>
                  <td>
                    <input className="date" placeholder="YYYY-MM / present" value={r.end ?? ''} onChange={(e) => up((d) => void ((d.experience[i]!.end = e.target.value || null), (d.experience[i]!.datesLocked = true)))} />
                    {r.datesLocked && <div className="muted">🔒 locked</div>}
                  </td>
                  <td>
                    <button className="link" onClick={() => up((d) => void d.experience.splice(i, 1))}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="secondary"
            onClick={() =>
              up((d) =>
                d.experience.push({
                  id: uniq('exp.new', d.experience.map((x) => x.id)),
                  kind: 'work',
                  company: { he: null, en: null },
                  title: { he: null, en: null },
                  start: null,
                  end: null,
                  skills: [],
                  highlights: { he: [], en: [] },
                  datesLocked: true,
                }),
              )
            }
          >
            + add role
          </button>
        </fieldset>
      )}

      {show('skills') && (
        <fieldset>
          <legend>Skills</legend>
          <p className="muted">
            basic = counts for scoring/matching but never auto-answers a yes/no or years question. Link each skill to the work roles where you used it — years
            are computed from those dates. Removing a skill blocks it from coming back with a CV update.
          </p>
          <table className="edit-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Level</th>
                <th>Aliases (comma separated)</th>
                <th>Used in roles</th>
                <th>Years</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.skills.map((s, i) => {
                const y = data.derived?.skillYears[s.id];
                return (
                  <tr key={s.id}>
                    <td>
                      <input value={s.name} onChange={(e) => up((d) => void (d.skills[i]!.name = e.target.value))} />
                    </td>
                    <td>
                      <select value={s.level ?? 'strong'} onChange={(e) => up((d) => void (d.skills[i]!.level = e.target.value as Skill['level']))}>
                        <option>strong</option>
                        <option>basic</option>
                      </select>
                    </td>
                    <td>
                      <input defaultValue={commas(s.aliases)} onBlur={(e) => up((d) => void (d.skills[i]!.aliases = fromCommas(e.target.value)))} />
                    </td>
                    <td className="role-links">
                      {p.experience.map((r, ri) => (
                        <label key={r.id} title={r.kind}>
                          <input
                            type="checkbox"
                            checked={r.skills.includes(s.id)}
                            onChange={(e) =>
                              up((d) => {
                                const role = d.experience[ri]!;
                                role.skills = e.target.checked ? [...new Set([...role.skills, s.id])] : role.skills.filter((x) => x !== s.id);
                              })
                            }
                          />
                          <span dir="auto">{roleLabel(r)}</span>
                        </label>
                      ))}
                    </td>
                    <td className="muted">
                      {y?.years ?? '—'}
                      {y?.source ? ` (${y.source})` : ''}
                      <div>
                        stated <Num value={s.statedYears} onChange={(v) => up((d) => void (d.skills[i]!.statedYears = v ?? null))} step={0.5} min={0} />
                      </div>
                    </td>
                    <td>
                      <button className="link" onClick={() => removeSkill(s)}>
                        remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            className="secondary"
            onClick={() => up((d) => d.skills.push({ id: uniq(`skill.new`, d.skills.map((x) => x.id)), name: 'New skill', aliases: [], statedYears: null, level: 'strong' }))}
          >
            + add skill
          </button>
          {p.blockedSkills?.length > 0 && <p className="muted">Blocked (never re-added by CV updates): {p.blockedSkills.join(', ')}</p>}
        </fieldset>
      )}

      {show('education') && (
        <fieldset>
          <legend>Education</legend>
          <table className="edit-table">
            <tbody>
              {p.education.map((e, i) => (
                <tr key={e.id}>
                  <td>
                    <input dir="rtl" placeholder="institution (he)" value={e.institution.he ?? ''} onChange={(v) => up((d) => void (d.education[i]!.institution.he = v.target.value || null))} />
                    <input placeholder="institution (en)" value={e.institution.en ?? ''} onChange={(v) => up((d) => void (d.education[i]!.institution.en = v.target.value || null))} />
                  </td>
                  <td>
                    <input dir="rtl" placeholder="degree (he)" value={e.degree.he ?? ''} onChange={(v) => up((d) => void (d.education[i]!.degree.he = v.target.value || null))} />
                    <input placeholder="degree (en)" value={e.degree.en ?? ''} onChange={(v) => up((d) => void (d.education[i]!.degree.en = v.target.value || null))} />
                  </td>
                  <td>
                    <input className="date" placeholder="start" value={e.start ?? ''} onChange={(v) => up((d) => void ((d.education[i]!.start = v.target.value || null), (d.education[i]!.datesLocked = true)))} />
                    <input className="date" placeholder="end" value={e.end ?? ''} onChange={(v) => up((d) => void ((d.education[i]!.end = v.target.value || null), (d.education[i]!.datesLocked = true)))} />
                  </td>
                  <td>
                    <button className="link" onClick={() => up((d) => void d.education.splice(i, 1))}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="secondary"
            onClick={() =>
              up((d) =>
                d.education.push({ id: uniq('edu.new', d.education.map((x) => x.id)), institution: { he: null, en: null }, degree: { he: null, en: null }, field: { he: null, en: null }, start: null, end: null, datesLocked: true }),
              )
            }
          >
            + add education
          </button>
        </fieldset>
      )}

      {show('declared') && (
        <fieldset>
          <legend>Declared experience</legend>
          <p className="muted">Answers only GENERAL questions (“N years of software development”). Technology questions always use your work roles.</p>
          <label>
            <input
              type="checkbox"
              checked={!!p.declaredExperience}
              onChange={(e) => up((d) => void (d.declaredExperience = e.target.checked ? { totalDevYears: 0, basis: '' } : null))}
            />{' '}
            I want to declare my total development experience
          </label>
          {p.declaredExperience && (
            <div className="grid2">
              <Field label="Total years of professional development">
                <Num value={p.declaredExperience.totalDevYears} step={0.5} min={0} onChange={(v) => up((d) => void (d.declaredExperience!.totalDevYears = v ?? 0))} />
              </Field>
              <Field label="Basis (shown in the review queue whenever it is used)">
                <input dir="auto" value={p.declaredExperience.basis} onChange={(e) => up((d) => void (d.declaredExperience!.basis = e.target.value))} />
              </Field>
            </div>
          )}
        </fieldset>
      )}

      {show('links') && !compact && (
        <fieldset>
          <legend>Links & languages</legend>
          {p.links.map((l, i) => (
            <div key={l.id} className="grid2">
              <input value={l.label} onChange={(e) => up((d) => void (d.links[i]!.label = e.target.value))} />
              <input value={l.url} onChange={(e) => up((d) => void (d.links[i]!.url = e.target.value))} />
            </div>
          ))}
          <button className="secondary" onClick={() => up((d) => d.links.push({ id: uniq('link.new', d.links.map((x) => x.id)), label: 'link', url: '' }))}>
            + add link
          </button>
          <TextList
            value={p.languages.map((l) => `${l.name.en ?? l.name.he ?? ''}${l.level.en || l.level.he ? ` — ${l.level.en ?? l.level.he}` : ''}`)}
            onChange={(v) =>
              up((d) => {
                d.languages = v.map((line) => {
                  const [name, level] = line.split(/\s+—\s+|\s+-\s+/);
                  return { id: `lang.${slug(name ?? 'x')}`, name: { he: null, en: name ?? '' }, level: { he: null, en: level ?? null } };
                });
              })
            }
            placeholder="Hebrew — Native"
          />
        </fieldset>
      )}
    </section>
  );
}
