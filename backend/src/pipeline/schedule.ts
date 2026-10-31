/**
 * Scheduled hunts. Two ways, both at the same configured times (default 09:15 and 16:15, Sunday–Thursday) and never
 * inside quiet hours:
 *   - in-app, while JobHunter is running (OFF by default; Settings → Schedule);
 *   - Windows Task Scheduler (npm run schedule:install), which runs `npm start -- --hunt --no-browser` while you are
 *     logged in to Windows.
 */
import { readSettingsFile, writeSettingsFile } from '../llm/settings.js';

export interface ScheduleSettings {
  /** in-app scheduler (while the app runs) */
  enabled: boolean;
  /** "HH:MM", local time */
  times: string[];
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** no hunt starts in [from, to) — may wrap past midnight */
  quietHours: { from: string; to: string };
  /** Windows toast with the summary when a hunt ends */
  toast: boolean;
}

export const DEFAULT_SCHEDULE: ScheduleSettings = { enabled: false, times: ['09:15', '16:15'], days: [0, 1, 2, 3, 4], quietHours: { from: '22:00', to: '07:00' }, toast: true };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHhmm = (s: string) => HHMM.test(s);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function scheduleSettings(): ScheduleSettings {
  const s = (readSettingsFile() as { schedule?: Partial<ScheduleSettings> }).schedule ?? {};
  return {
    enabled: s.enabled === true,
    times: Array.isArray(s.times) ? s.times.filter(isHhmm).sort() : DEFAULT_SCHEDULE.times,
    days: Array.isArray(s.days) ? [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_SCHEDULE.days,
    quietHours: s.quietHours && isHhmm(s.quietHours.from) && isHhmm(s.quietHours.to) ? s.quietHours : DEFAULT_SCHEDULE.quietHours,
    toast: s.toast !== false,
  };
}

export function saveScheduleSettings(patch: Partial<ScheduleSettings>): ScheduleSettings {
  const file = readSettingsFile();
  writeSettingsFile({ ...file, schedule: { ...scheduleSettings(), ...patch } } as typeof file);
  return scheduleSettings();
}

/** Inside quiet hours? [from, to), wrapping past midnight when from > to. */
export function inQuietHours(hhmm: string, q: ScheduleSettings['quietHours']): boolean {
  const t = minutes(hhmm);
  const from = minutes(q.from);
  const to = minutes(q.to);
  if (from === to) return false;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** The configured times that can actually run (a time inside quiet hours never does). */
export const runnableTimes = (s: ScheduleSettings) => s.times.filter((t) => !inQuietHours(t, s.quietHours));

const pad = (n: number) => String(n).padStart(2, '0');
const localHhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** how late a slot may still start (the app may be busy, or the timer slightly late) */
export const SLOT_GRACE_MIN = 10;

/**
 * The slot due now, if any: today is a scheduled day, now is within SLOT_GRACE_MIN after the slot, the slot did not
 * run today, and now is not in quiet hours. `ran` holds "YYYY-MM-DD HH:MM" keys of slots already started.
 */
export function dueSlot(now: Date, s: ScheduleSettings, ran: Set<string>): string | null {
  if (!s.days.includes(now.getDay())) return null;
  const t = localHhmm(now);
  if (inQuietHours(t, s.quietHours)) return null;
  const nowMin = minutes(t);
  for (const slot of runnableTimes(s)) {
    const d = nowMin - minutes(slot);
    if (d >= 0 && d <= SLOT_GRACE_MIN && !ran.has(`${localDay(now)} ${slot}`)) return `${localDay(now)} ${slot}`;
  }
  return null;
}

/** The next time a scheduled hunt would start (for the dashboard), or null when nothing can run. */
export function nextRun(now: Date, s: ScheduleSettings): Date | null {
  const times = runnableTimes(s);
  if (!times.length || !s.days.length) return null;
  for (let add = 0; add <= 7; add++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
    if (!s.days.includes(day.getDay())) continue;
    for (const t of times) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(t.slice(0, 2)), Number(t.slice(3, 5)));
      if (at > now) return at;
    }
  }
  return null;
}
