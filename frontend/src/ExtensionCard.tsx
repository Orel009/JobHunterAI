import { useEffect, useState } from 'react';

/** Settings: the JobHunter Fill extension (your regular Chrome) — where it is, the token to paste, a new token. */
export function ExtensionCard() {
  const [info, setInfo] = useState<{ token: string; folder: string } | null>(null);
  const [shown, setShown] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/extension')
      .then((r) => r.json())
      .then(setInfo)
      .catch((e: Error) => setNote(e.message));
  }, []);
  const copy = (t: string, what: string) => void navigator.clipboard.writeText(t).then(() => setNote(`${what} copied`));
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
        <li>On an application form: click the JobHunter Fill button.</li>
      </ol>
      {info && (
        <>
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
