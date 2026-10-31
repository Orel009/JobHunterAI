import { useCallback, useEffect, useState } from 'react';
import { answers, type BankEntry } from './api';

const TYPES: BankEntry['type'][] = ['text', 'yes_no', 'choice', 'number'];

export function AnswersBank({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<BankEntry[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState({ question: '', answer: '', type: 'text' as BankEntry['type'] });

  const load = useCallback(async () => {
    const list = await answers.list();
    // pending first, then by how many open applications they block
    list.sort((a, b) => (a.status === b.status ? b.blocks - a.blocks : a.status === 'pending' ? -1 : 1));
    setItems(list);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
    await load();
    onChanged();
  };

  const pending = items.filter((i) => i.status === 'pending').length;

  return (
    <section className="bank">
      <div className="filters">
        <b>{pending} pending</b>
        <span className="muted">· {items.length} total</span>
        <button className="secondary" onClick={() => act(answers.seed)}>
          Seed from preferences.yaml
        </button>
        {msg && <span className="note">{msg}</span>}
      </div>

      <div className="new-entry">
        <input dir="auto" placeholder="question" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
        <input dir="auto" placeholder="answer (empty = pending)" value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
        <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as BankEntry['type'] })}>
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button
          disabled={!draft.question.trim()}
          onClick={() =>
            act(async () => {
              await answers.create({ question: draft.question, answer: draft.answer || null, type: draft.type });
              setDraft({ question: '', answer: '', type: 'text' });
            })
          }
        >
          Add
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Answer</th>
            <th>Type</th>
            <th>Blocks</th>
            <th>Used</th>
            <th>Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <Row key={e.id} e={e} act={act} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Row({ e, act }: { e: BankEntry; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [answer, setAnswer] = useState(e.answer ?? '');
  const dirty = answer !== (e.answer ?? '');
  const save = (v: string) => act(() => answers.update(e.id, { answer: v || null }));
  return (
    <tr className={e.status === 'pending' ? 'pending-row' : ''}>
      <td dir="auto">{e.question}</td>
      <td>
        {e.type === 'yes_no' ? (
          <span>
            <button className={answer === 'כן' ? '' : 'secondary'} onClick={() => save('כן')}>
              כן
            </button>{' '}
            <button className={answer === 'לא' ? '' : 'secondary'} onClick={() => save('לא')}>
              לא
            </button>
          </span>
        ) : (
          <span className="inline-edit">
            <input dir="auto" value={answer} placeholder="pending" onChange={(ev) => setAnswer(ev.target.value)} />
            {dirty && <button onClick={() => save(answer)}>save</button>}
          </span>
        )}
      </td>
      <td className="muted">{e.type}</td>
      <td>{e.blocks > 0 ? <span className="badge warn">{e.blocks}</span> : <span className="muted">0</span>}</td>
      <td className="muted">{e.usageCount}</td>
      <td className="muted">{e.source}</td>
      <td>
        <button className="link" onClick={() => window.confirm('Delete this entry?') && void act(() => answers.remove(e.id))}>
          delete
        </button>
      </td>
    </tr>
  );
}
