import { useCallback, useEffect, useState } from 'react';
import { llm, type LlmSettings, type Status, type TaskCfg } from './api';
import { Field, Issues } from './forms';
import { PreferencesEditor } from './PreferencesEditor';
import { ProfileEditor } from './ProfileEditor';
import { CvUploads } from './ProfileScreen';
import { KeyInputs, PrivacyNotice, TaskPicker } from './SettingsScreen';

type Gender = 'male' | 'female' | null;
interface OnboardingInfo {
  needed: boolean;
  state: { step: number; name: string; gender: Gender };
  draftExists: boolean;
  profileExists: boolean;
}
interface StdQuestion {
  key: string;
  question: string;
  type: 'text' | 'yes_no' | 'choice' | 'number';
  value: string | number | boolean;
}

const STEPS = [
  { title: 'About you', he: 'עליך' },
  { title: 'Language model', he: 'מודל שפה' },
  { title: 'Your CV', he: 'קורות חיים' },
  { title: 'Review your profile', he: 'בדיקת הפרופיל' },
  { title: 'Skills', he: 'כישורים' },
  { title: 'Experience', he: 'ניסיון' },
  { title: 'What to search', he: 'מה לחפש' },
  { title: 'Drushim', he: 'דרושים' },
  { title: 'Standard answers', he: 'תשובות קבועות' },
];

const put = (b: Record<string, unknown>) => fetch('/api/onboarding', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

export function Wizard({ status, onDone }: { status: Status | null; onDone: () => void }) {
  const [info, setInfo] = useState<OnboardingInfo | null>(null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<Gender>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  // LLM step
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskCfg>>({});
  const [sameModel, setSameModel] = useState(true);
  // answers step
  const [questions, setQuestions] = useState<StdQuestion[] | null>(null);

  const load = useCallback(async () => {
    const i = (await (await fetch('/api/onboarding')).json()) as OnboardingInfo;
    setInfo(i);
    setStep(Math.min(i.state.step, STEPS.length - 1));
    setName(i.state.name);
    setGender(i.state.gender);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDirty(false);
    setError(null);
    setIssues([]);
    if (step === 1 && !settings)
      void llm.settings().then((s) => {
        setSettings(s);
        setTasks({ analyze: s.analyze, write: s.write });
        setSameModel(s.analyze.provider === s.write.provider && s.analyze.model === s.write.model);
      });
    if (step === 8) void fetch('/api/onboarding/standard-questions').then(async (r) => setQuestions((await r.json()) as StdQuestion[]));
    if (step === 2 || step === 3) void load();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;

  const go = async (to: number) => {
    setError(null);
    try {
      if (step === 0) {
        if (!name.trim()) throw new Error('Please enter your name');
        if (!gender) throw new Error('Please choose how Hebrew text should address you');
        await put({ name: name.trim(), gender, step: to });
      } else if (step === 1 && to > step) {
        const t = sameModel ? { analyze: tasks.analyze!, write: tasks.analyze! } : { analyze: tasks.analyze!, write: tasks.write! };
        if (!t.analyze.model || !t.write.model) throw new Error('Choose a model');
        await llm.save(t);
        await put({ step: to });
      } else if (step === 2 && to > step) {
        const i = (await (await fetch('/api/onboarding')).json()) as OnboardingInfo;
        if (!i.draftExists && !i.profileExists) throw new Error('Upload at least one CV and wait until it has been read');
        await put({ name, gender, step: to }); // your name + gender win over what the CV extraction found
      } else await put({ step: to });
      setStep(to);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const finish = async () => {
    setError(null);
    setIssues([]);
    if (questions) {
      const r = (await (await fetch('/api/preferences')).json()) as { preferences: { standardAnswers: Record<string, unknown> } };
      const prefs = r.preferences;
      prefs.standardAnswers = Object.fromEntries(questions.map((q) => [q.key, q.value]));
      const s = await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preferences: prefs }) });
      if (!s.ok) {
        const j = (await s.json()) as { error?: string; issues?: string[] };
        setError(j.error ?? 'could not save the answers');
        setIssues(j.issues ?? []);
        return;
      }
    }
    const res = await fetch('/api/onboarding/finish', { method: 'POST' });
    const j = (await res.json()) as { error?: string; issues?: string[] };
    if (!res.ok) {
      setError(`${j.error ?? 'failed'} — fix it in the earlier steps (Review your profile)`);
      setIssues(j.issues ?? []);
      return;
    }
    onDone();
  };

  const skip = async () => {
    if (!confirm('Close the setup wizard? Everything stays editable on the Profile, Preferences and Settings screens.')) return;
    await fetch('/api/onboarding/skip', { method: 'POST' });
    onDone();
  };

  const isLast = step === STEPS.length - 1;
  const labels = Object.fromEntries((settings?.providers ?? []).map((p) => [p.id, p.label]));
  const login = status?.sessions.drushim?.state;

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h2>
          Setup — step {step + 1} of {STEPS.length}: {STEPS[step]!.title} <span dir="rtl">· {STEPS[step]!.he}</span>
        </h2>
        <ol className="wizard-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className={i === step ? 'current' : i < step ? 'done' : ''}>
              {s.title}
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && (
        <section className="editor">
          <p>JobHunter finds jobs that fit you, scores them, and prepares applications for you to approve. Everything stays on this computer unless you choose a cloud model.</p>
          <Field label="Your full name (as on your CV)">
            <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="How should Hebrew text address and describe you?" hint="Hebrew verbs and adjectives are gendered: this sets the forms in every answer written for you">
            <div className="row">
              <label>
                <input type="radio" checked={gender === 'female'} onChange={() => setGender('female')} /> <span dir="rtl">לשון נקבה (אני מתעניינת)</span>
              </label>
              <label>
                <input type="radio" checked={gender === 'male'} onChange={() => setGender('male')} /> <span dir="rtl">לשון זכר (אני מתעניין)</span>
              </label>
            </div>
          </Field>
        </section>
      )}

      {step === 1 && settings && (
        <section className="editor">
          <p>
            Choose the model that reads job posts and writes your answers. <b>Ollama</b> runs on your own computer, free and private (it needs a decent GPU). API providers are faster on
            weak computers but cost money per use and receive your data.
          </p>
          <PrivacyNotice providers={Object.values(sameModel ? { a: tasks.analyze } : tasks).map((t) => t?.provider ?? '')} labels={labels} />
          <TaskPicker label={sameModel ? 'Model for everything' : 'Analyze'} value={tasks.analyze ?? { provider: 'ollama', model: '' }} providers={settings.providers} onChange={(v) => setTasks({ ...tasks, analyze: v })} />
          <label>
            <input type="checkbox" checked={!sameModel} onChange={(e) => setSameModel(!e.target.checked)} /> use a different model for writing answers
          </label>
          {!sameModel && <TaskPicker label="Write" value={tasks.write ?? { provider: 'ollama', model: '' }} providers={settings.providers} onChange={(v) => setTasks({ ...tasks, write: v })} />}
          <KeyInputs settings={settings} only={[...new Set(Object.values(tasks).map((t) => t.provider))]} onSaved={setSettings} />
          <p className="muted">Save the API key first, then press “Test connection”. You can change all of this later on the Settings screen.</p>
        </section>
      )}

      {step === 2 && (
        <section className="editor">
          <p>Upload your CV as a PDF: Hebrew, English, or both. It is read by the model you chose; nothing is saved to your profile until you review it in the next steps.</p>
          <CvUploads onChanged={() => void load()} />
          {info.draftExists && <div className="banner ok-banner">Your CV has been read. Continue to review what was found.</div>}
        </section>
      )}

      {step === 3 && (
        <>
          <p className="muted">Check your details, roles and education. Fix anything that is wrong, then press Save before continuing.</p>
          <ProfileEditor compact sections={['contact', 'roles', 'education']} onDirtyChange={setDirty} />
        </>
      )}
      {step === 4 && (
        <>
          <p className="muted">
            Set each skill's level (<b>basic</b> skills count for matching but are never used to auto-answer “do you have experience with…” questions) and link skills to the roles where
            you used them — years of experience are computed from those links. Remove skills that don't belong.
          </p>
          <ProfileEditor compact sections={['skills']} onDirtyChange={setDirty} />
        </>
      )}
      {step === 5 && (
        <>
          <p className="muted">Optional: your total development experience as you would state it, used for “how many years of experience do you have?” questions.</p>
          <ProfileEditor compact sections={['declared']} onDirtyChange={setDirty} />
        </>
      )}
      {step === 6 && (
        <>
          <p className="muted">Which roles to search for, where you can work, and the most years of experience a job may require.</p>
          <PreferencesEditor sections={['roles', 'where']} onDirtyChange={setDirty} />
        </>
      )}
      {step === 7 && (
        <>
          <p className="muted">
            Applications send a CV that is stored on your Drushim account. Upload your CV(s) to Drushim, then type their names here exactly as Drushim shows them.
          </p>
          <PreferencesEditor sections={['cv']} onDirtyChange={setDirty} />
          <section className="editor">
            <fieldset>
              <legend>Drushim login</legend>
              <p>
                Opens a browser window on Drushim. <b>You</b> log in there (JobHunter never types your password), then close the window. Status:{' '}
                <span className={login === 'logged_in' ? 'badge ok' : 'badge warn'}>{login === 'logged_in' ? 'logged in' : login === 'logged_out' ? 'not logged in' : 'unknown'}</span>
              </p>
              <button
                onClick={() =>
                  void fetch('/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => {
                    if (!r.ok) setError(((await r.json()) as { error?: string }).error ?? 'failed');
                  })
                }
              >
                Open the Drushim login window
              </button>{' '}
              <span className="muted">You can also do this later (terminal: npm run login -- drushim).</span>
            </fieldset>
          </section>
        </>
      )}
      {step === 8 && questions && (
        <section className="editor">
          <p>Answers to questions almost every application form asks. Leave a field empty to be asked each time instead.</p>
          <div className="grid2">
            {questions.map((q, i) => (
              <Field key={q.key} label={q.question}>
                {q.type === 'yes_no' ? (
                  <select
                    value={q.value === true ? 'כן' : q.value === false ? 'לא' : String(q.value)}
                    onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? { ...x, value: e.target.value === 'כן' ? true : e.target.value === 'לא' ? false : '' } : x)))}
                  >
                    <option value="">— ask me each time —</option>
                    <option value="כן">כן</option>
                    <option value="לא">לא</option>
                  </select>
                ) : (
                  <input dir="auto" value={String(q.value)} onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                )}
              </Field>
            ))}
          </div>
        </section>
      )}

      {error && <div className="banner error">{error}</div>}
      <Issues issues={issues} />
      <div className="wizard-nav">
        <button className="secondary" disabled={step === 0} onClick={() => void go(step - 1)}>
          ← Back
        </button>
        {isLast ? (
          <button className="primary" onClick={() => void finish()}>
            Finish setup
          </button>
        ) : (
          <button className="primary" disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => void go(step + 1)}>
            Next →
          </button>
        )}
        {dirty && <span className="note">Save your changes first</span>}
        <button className="link" onClick={() => void skip()}>
          set up later
        </button>
      </div>
    </div>
  );
}
