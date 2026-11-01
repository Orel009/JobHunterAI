import { useCallback, useEffect, useState } from 'react';
import { api, profileStatus, type Status } from './api';
import { AnswersBank } from './AnswersBank';
import { Controls } from './Controls';
import { JobsScreen } from './JobsScreen';
import { LogPanel } from './LogPanel';
import { ReviewQueue } from './ReviewQueue';
import { PreferencesEditor } from './PreferencesEditor';
import { ProfileScreen } from './ProfileScreen';
import { SettingsScreen } from './SettingsScreen';
import { Wizard } from './Wizard';
import { LinkedInScreen } from './LinkedInScreen';
import { CompaniesScreen } from './CompaniesScreen';
import { MarketScreen } from './MarketScreen';
import { HistoryScreen } from './HistoryScreen';
import { AutoSubmitKillSwitch } from './AutoSubmit';
import { RunAndSendButton, RunAndSendPanel } from './RunAndSend';
import { LlmOffer } from './LlmOffer';

const TABS = [
  { id: 'jobs', label: 'Jobs', enabled: true },
  { id: 'review', label: 'Review queue', enabled: true },
  { id: 'answers', label: 'Answers bank', enabled: true },
  { id: 'profile', label: 'Profile', enabled: true },
  { id: 'prefs', label: 'Preferences', enabled: true },
  { id: 'market', label: 'Market', enabled: true },
  { id: 'linkedin', label: 'Email alerts', enabled: true },
  { id: 'companies', label: 'Companies', enabled: true },
  { id: 'settings', label: 'Settings', enabled: true },
  { id: 'history', label: 'History', enabled: true },
] as const;

type ProfileState = Awaited<ReturnType<typeof profileStatus>>;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [cvInfo, setCvInfo] = useState<{ state: Record<string, { needsDrushimUpdate: boolean }>; drushimCvNames: { he: string; en: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('jobs');
  const [tick, setTick] = useState(0);
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  const checkOnboarding = useCallback(async () => {
    try {
      setOnboarding(((await (await fetch('/api/onboarding')).json()) as { needed: boolean }).needed);
    } catch {
      setOnboarding(false);
    }
  }, []);
  useEffect(() => {
    void checkOnboarding();
  }, [checkOnboarding]);

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
          {TABS.filter((t) => t.id !== 'linkedin' || status?.emailAlerts.enabled || !!status?.needsManual || !!status?.companies?.listed).map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} disabled={!t.enabled || !!onboarding} onClick={() => setTab(t.id)}>
              {t.id === 'linkedin' && !status?.emailAlerts.enabled ? 'Assisted apply' : t.label}
              {t.id === 'linkedin' && !!status?.needsManual && <span className="badge warn"> {status.needsManual} by hand</span>}
            </button>
          ))}
        </nav>
        {status && onboarding === false && <RunAndSendButton status={status} onChange={refresh} />}
        {status && onboarding === false && <AutoSubmitKillSwitch status={status} onChange={refresh} openSettings={() => setTab('settings')} />}
      </header>
      {status && onboarding === false && <RunAndSendPanel status={status} />}
      <LlmOffer onChange={refresh} />
      {status?.dryRun === false && <div className="banner live-banner">DRY_RUN is OFF — approving in the review queue submits real applications.</div>}
      {error && <div className="banner error">{error} — is JobHunter running (npm start)?</div>}
      {status?.sessions.drushim?.state === 'logged_out' && onboarding === false && (
        <div className="banner error">
          <div dir="rtl">אין חיבור לדרושים — ההגשה מושבתת. יש לפתוח את חלון ההתחברות, להתחבר ולסגור את החלון.</div>
          <div dir="ltr">
            Not logged in to Drushim — applying is disabled.{' '}
            <button className="link" onClick={() => void fetch('/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })}>
              Open the login window
            </button>
            , log in yourself, then close the window (or run <code>npm run login -- drushim</code>).
          </div>
        </div>
      )}
      {profile && !profile.valid && onboarding === false && (
        <div className="banner error">
          <div dir="rtl">
            {profile.draftExists && !profile.exists ? 'הפרופיל עוד לא אושר' : 'אין פרופיל תקין'} — משרות נמצאות, אבל הדירוג ממתין. אחרי האישור הדירוג מתחיל אוטומטית.
          </div>
          <div>
            {profile.exists
              ? `profile.json is invalid: ${profile.error}`
              : profile.draftExists
                ? 'Your profile draft is not approved yet: review it and click “Approve draft”.'
                : 'No profile yet: upload your CV on the Profile screen.'}{' '}
            Discovery still works; scoring waits{status?.waitingForScore ? ` (${status.waitingForScore} job(s) waiting)` : ''} and starts by itself once the profile is
            approved.{' '}
            <button className="primary" onClick={() => setTab('profile')}>
              Open Profile
            </button>
          </div>
        </div>
      )}
      {cvInfo &&
        Object.entries(cvInfo.state)
          .filter(([, s]) => s.needsDrushimUpdate)
          .map(([lang]) => (
            <div key={lang} className="banner warn">
              <div dir="rtl">
                קורות החיים ({lang === 'he' ? 'עברית' : 'אנגלית'}) עודכנו — יש לעדכן אותם גם בדרושים. המערכת שולחת את הקובץ ששמור בחשבון שלך בדרושים.
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
      {onboarding && (
        <Wizard
          status={status}
          onDone={() => {
            void checkOnboarding();
            void refresh();
          }}
        />
      )}
      {onboarding === false && status && <Controls status={status} onChange={refresh} profileReady={profile?.valid ?? true} />}
      {onboarding === false && tab === 'jobs' && <JobsScreen refreshKey={status?.activeRun ? tick : 0} sites={status?.sites ?? []} alertSources={status?.emailAlerts.enabled ? status.emailAlerts.sources : []} roleTypes={status?.roleTypes ?? []} applyDisabled={status?.sessions.drushim?.state === 'logged_out'} />}
      {onboarding === false && tab === 'review' && <ReviewQueue dryRun={status?.dryRun ?? true} busy={!!status?.activeRun} runLabel={status?.activeRun ? `${status.activeRun.site}/${status.activeRun.kind}: ${status.activeRun.stage}` : null} loggedOut={Object.entries(status?.sessions ?? {}).filter(([, v]) => v.state === 'logged_out').map(([k]) => k)} onChanged={refresh} />}
      {onboarding === false && tab === 'answers' && <AnswersBank onChanged={refresh} />}
      {onboarding === false && tab === 'profile' && <ProfileScreen onChanged={refresh} />}
      {onboarding === false && tab === 'prefs' && <PreferencesEditor onSaved={refresh} />}
      {onboarding === false && tab === 'linkedin' && (status?.emailAlerts.enabled || !!status?.needsManual || !!status?.companies?.listed) && (
        <LinkedInScreen
          sources={[...(status.emailAlerts.enabled ? status.emailAlerts.sources : []), ...(status.companies?.listed ? ['greenhouse', 'comeet', 'smartrecruiters'] : [])]}
          alertsOn={status.emailAlerts.enabled}
          busy={!!status.activeRun}
          onChanged={refresh}
        />
      )}
      {onboarding === false && tab === 'companies' && <CompaniesScreen busy={!!status?.activeRun} onChanged={refresh} />}
      {onboarding === false && tab === 'history' && <HistoryScreen />}
      {onboarding === false && tab === 'market' && <MarketScreen onSaved={refresh} />}
      {onboarding === false && tab === 'settings' && <SettingsScreen onSaved={refresh} sites={status?.sites ?? []} pauses={status?.pauses ?? {}} busy={!!status?.activeRun} />}
      <LogPanel />
    </div>
  );
}
