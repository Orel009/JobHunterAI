import { useEffect, useState } from 'react';

/** Settings: the JobHunter Fill extension (your regular Chrome) — where it is, the token to paste, a new token. */
export function ExtensionCard() {
  const [info, setInfo] = useState<{ token: string; folder: string; settings?: { fillCoverLetters: boolean; styleSample?: string; draftOptionalFields?: boolean } } | null>(null);
  const [shown, setShown] = useState(false);
  const [sample, setSample] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/extension')
      .then((r) => r.json())
      .then((x: NonNullable<typeof info>) => {
        setInfo(x);
        setSample(x.settings?.styleSample ?? '');
      })
      .catch((e: Error) => setNote(e.message));
  }, []);
  const copy = (t: string, what: string) => void navigator.clipboard.writeText(t).then(() => setNote(`${what} copied`));
  const setCoverLetters = async (on: boolean) => {
    const r = (await (await fetch('/api/extension/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fillCoverLetters: on }) })).json()) as { fillCoverLetters: boolean };
    setInfo((i) => (i ? { ...i, settings: r } : i));
    setNote(on ? 'cover letters: the extension fills an AI draft (purple) for you to review' : 'cover letters: the extension leaves them empty');
  };
  const setOptional = async (on: boolean) => {
    const r = (await (await fetch('/api/extension/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftOptionalFields: on }) })).json()) as NonNullable<NonNullable<typeof info>['settings']>;
    setInfo((i) => (i ? { ...i, settings: r } : i));
    setNote(on ? 'optional cover / bio / summary fields get drafts too' : 'only required cover / bio fields get drafts; optional ones are listed yellow with the reason');
  };
  const saveSample = async () => {
    const r = (await (await fetch('/api/extension/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ styleSample: sample ?? '' }) })).json()) as {
      fillCoverLetters: boolean;
      styleSample: string;
    };
    setInfo((i) => (i ? { ...i, settings: r } : i));
    setNote(r.styleSample ? 'writing style sample saved: drafts follow your style' : 'writing style sample cleared');
  };
  const regenerate = async () => {
    const r = (await (await fetch('/api/extension/token', { method: 'POST' })).json()) as { token: string };
    setInfo((i) => (i ? { ...i, token: r.token } : i));
    setShown(true);
    setNote('new token — paste it into the extension options (the old one no longer works)');
  };
  return (
    <fieldset className="card">
      <legend>JobHunter Fill (Chrome extension, optional)</legend>
      <p className="muted">
        Fills an application form in your <b>regular</b> Chrome when you click its button: your details, the prepared answers, the salary by your rules. It never submits,
        never clicks buttons and never touches CAPTCHA; you check the form, attach the CV it names, and submit yourself. It talks only to this JobHunter, with this token.
      </p>
      <ol className="muted">
        <li>Chrome → <code>chrome://extensions</code> → turn on <b>Developer mode</b> → <b>Load unpacked</b> → choose the folder below.</li>
        <li>Pin it, open its <b>Options</b>, paste the token, <b>Save and test</b>.</li>
        <li>On an application form: click the JobHunter Fill button, then <b>Fill this form</b>. On LinkedIn and Indeed it does nothing (manual only: use the copy panel).</li>
      </ol>
      {info && (
        <>
          <label className="row" title="the automated sites (Drushim, JobMaster, Jobnet, JobKarov) always keep cover letters empty">
            <input type="checkbox" checked={info.settings?.fillCoverLetters !== false} onChange={(e) => void setCoverLetters(e.target.checked)} />
            <span>
              <b>Fill cover letters in the extension</b> — a short AI draft from your profile facts (2–4 plain sentences in the job&apos;s language: 1–2 facts that match the job
              and one reason from the ad; no clichés, no em dashes, no lists), marked purple for you to review and edit before you submit. The automated sites keep cover letters
              empty.
            </span>
          </label>
          <label className="row" title="a cover letter, message, bio or summary the form marks optional">
            <input type="checkbox" checked={info.settings?.draftOptionalFields !== false} onChange={(e) => void setOptional(e.target.checked)} />
            <span>
              <b>Draft optional cover / bio fields</b> — a cover letter, message, bio or summary gets its draft even when the form marks it optional (default on). Off: only
              required ones; the optional ones are outlined yellow with the reason.
            </span>
          </label>
          <label>
            <b>Writing style sample</b>{' '}
            <span className="muted">— paste 2–3 short messages you wrote yourself; the drafts follow their tone and wording (never their facts). Empty = no sample.</span>
            <textarea dir="auto" rows={5} style={{ width: '100%' }} value={sample ?? ''} maxLength={4000} onChange={(e) => setSample(e.target.value)} />
          </label>
          <div className="row">
            <button className="secondary" disabled={sample === (info.settings?.styleSample ?? '')} onClick={() => void saveSample()}>
              Save style sample
            </button>
          </div>
          <div className="row">
            <b>Folder:</b> <code dir="ltr">{info.folder}</code>
            <button className="link" onClick={() => copy(info.folder, 'folder')}>
              copy
            </button>
          </div>
          <div className="row">
            <b>Token:</b> <code dir="ltr">{shown ? info.token : '••••••••••••••••'}</code>
            <button className="link" onClick={() => setShown((s) => !s)}>
              {shown ? 'hide' : 'show'}
            </button>
            <button className="link" onClick={() => copy(info.token, 'token')}>
              copy
            </button>
            <button className="link" onClick={() => void regenerate()}>
              new token
            </button>
          </div>
        </>
      )}
      {note && <p className="note">{note}</p>}
    </fieldset>
  );
}
