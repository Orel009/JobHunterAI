import { useCallback, useEffect, useState } from 'react';
import { api, profileStatus, type Status } from './api';
import { AnswersBank } from './AnswersBank';
import { Controls } from './Controls';
import { JobsScreen } from './JobsScreen';
import { LogPanel } from './LogPanel';
import { ReviewQueue } from './ReviewQueue';
import { PreferencesEditor } from './PreferencesEditor';
import { ProfileScreen } from './ProfileScreen';

const TABS = [
  { id: 'jobs', label: 'Jobs', enabled: true },
  { id: 'review', label: 'Review queue', enabled: true },
  { id: 'answers', label: 'Answers bank', enabled: true },
  { id: 'profile', label: 'Profile', enabled: true },
  { id: 'prefs', label: 'Preferences', enabled: true },
  { id: 'history', label: 'History (Phase 3)', enabled: false },
] as const;

type ProfileState = Awaited<ReturnType<typeof profileStatus>>;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [cvInfo, setCvInfo] = useState<{ state: Record<string, { needsDrushimUpdate: boolean }>; drushimCvNames: { he: string; en: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('jobs');
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setProfile(await profileStatus());
      setCvInfo(await (await fetch('/api/profile/cv')).json());
      setError(null);
    } catch (e) {
      setError(`API unreachable: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      void refresh();
      setTick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="app">
      <header>
        <h1>JobHunter</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} disabled={!t.enabled} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      {status?.dryRun === false && <div className="banner live-banner">DRY_RUN is OFF — approving in the review queue submits real applications.</div>}
      {error && <div className="banner error">{error} — is JobHunter running (npm start)?</div>}
      {status?.sessions.drushim?.state === 'logged_out' && (
        <div className="banner error">
          <div dir="rtl">לא מחובר לדרושים — ההגשה מושבתת. הרץ בטרמינל את הפקודה למטה, התחבר, סגור את החלון ולחץ “re-check login”.</div>
          <div dir="ltr">
            Not logged in to Drushim — applying is disabled. Run <code>npm run login -- drushim</code>, log in, close the window, then click “re-check login”.
          </div>
        </div>
      )}
      {profile && !profile.valid && (
        <div className="banner warn">
          {profile.exists
            ? `profile.json is invalid: ${profile.error}`
            : profile.draftExists
              ? 'profile.draft.json is waiting for your review: resolve data/profile/profile.conflicts.md, then rename it to profile.json.'
              : 'No profile yet: put cv-he.pdf / cv-en.pdf in data/profile and run npm run profile:init.'}
        </div>
      )}
      {cvInfo &&
        Object.entries(cvInfo.state)
          .filter(([, s]) => s.needsDrushimUpdate)
          .map(([lang]) => (
            <div key={lang} className="banner warn">
              <div dir="rtl">
                עדכנת את קורות החיים ({lang === 'he' ? 'עברית' : 'אנגלית'}) — עדכן אותם גם בדרושים. המערכת שולחת את הקובץ ששמור בחשבון שלך בדרושים.
              </div>
              <div>
                Update this CV on Drushim too — applications send the CV stored on your Drushim account. Drushim CV name in your preferences:{' '}
                <b dir="auto">{(cvInfo.drushimCvNames as Record<string, string>)[lang] || '(not set)'}</b>{' '}
                <button className="link" onClick={() => void fetch(`/api/profile/cv/${lang}/ack`, { method: 'POST' }).then(refresh)}>
                  I updated it on Drushim
                </button>
              </div>
            </div>
          ))}
      {status && <Controls status={status} onChange={refresh} />}
      {tab === 'jobs' && <JobsScreen refreshKey={status?.activeRun ? tick : 0} sites={status?.sites ?? []} roleTypes={status?.roleTypes ?? []} applyDisabled={status?.sessions.drushim?.state === 'logged_out'} />}
      {tab === 'review' && <ReviewQueue dryRun={status?.dryRun ?? true} busy={!!status?.activeRun} applyDisabled={status?.sessions.drushim?.state === 'logged_out'} onChanged={refresh} />}
      {tab === 'answers' && <AnswersBank onChanged={refresh} />}
      {tab === 'profile' && <ProfileScreen onChanged={refresh} />}
      {tab === 'prefs' && <PreferencesEditor onSaved={refresh} />}
      <LogPanel />
    </div>
  );
}
