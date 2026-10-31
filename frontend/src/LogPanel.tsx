import { useEffect, useRef, useState } from 'react';

interface Line {
  time: number;
  level: string;
  msg: string;
  [k: string]: unknown;
}

const MAX = 400;
const OMIT = new Set(['time', 'level', 'msg']);

export function LogPanel() {
  const [lines, setLines] = useState<Line[]>([]);
  const [openPanel, setOpenPanel] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (e) => {
      const l = JSON.parse(e.data as string) as Line;
      setLines((prev) => [...prev.slice(-(MAX - 1)), l]);
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <section className={openPanel ? 'log open' : 'log'}>
      <div className="log-head" onClick={() => setOpenPanel(!openPanel)}>
        Live log {openPanel ? '▾' : '▸'}
      </div>
      {openPanel && (
        <div className="log-body" ref={box}>
          {lines.map((l, i) => {
            const extra = Object.entries(l)
              .filter(([k]) => !OMIT.has(k))
              .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
              .join(' ');
            return (
              <div key={i} className={`ll ${l.level}`} dir="auto">
                <span className="t">{new Date(l.time).toLocaleTimeString('he-IL')}</span> <span className="lv">{l.level}</span> {l.msg}{' '}
                <span className="x">{extra}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
