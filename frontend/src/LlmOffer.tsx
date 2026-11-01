import { useEffect, useState } from 'react';
import { api, setLlmOffer, type LlmOfferChoice } from './api';

/**
 * A run that scores was refused because the model is not there (Ollama not running): start Ollama (as `npm start`
 * does) and run, run without scoring (the jobs are read and filtered, and wait), or cancel.
 */
export function LlmOffer({ onChange }: { onChange: () => void }) {
  const [offer, setOffer] = useState<{ reason: string; canStart: boolean; resolve: (c: LlmOfferChoice) => void } | null>(null);
  const [state, setState] = useState<string | null>(null);

  useEffect(() => {
    setLlmOffer((reason, canStart) => new Promise((resolve) => setOffer({ reason, canStart, resolve })));
    return () => setLlmOffer(null);
  }, []);
  if (!offer) return null;

  const done = (c: LlmOfferChoice) => {
    offer.resolve(c);
    setOffer(null);
    setState(null);
    onChange();
  };
  const start = async () => {
    setState('starting Ollama… (up to 30 seconds)');
    try {
      await api.startOllama();
      done('started');
    } catch (e) {
      setState((e as Error).message);
    }
  };

  return (
    <div className="banner warn">
      <b>{offer.reason}.</b> This run scores jobs.{' '}
      {offer.canStart && (
        <button disabled={state?.startsWith('starting')} onClick={() => void start()}>
          Start Ollama and run
        </button>
      )}{' '}
      <button className="secondary" disabled={state?.startsWith('starting')} onClick={() => done('without')} title="the jobs are read and filtered, and wait for scoring (next run or Score only)">
        Run without scoring
      </button>{' '}
      <button className="link" onClick={() => done('cancel')}>
        Cancel
      </button>
      {state && <span className="note"> {state}</span>}
    </div>
  );
}
