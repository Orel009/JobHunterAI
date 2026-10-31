#!/usr/bin/env node
/**
 * Windows Task Scheduler task for scheduled hunts (plain Node, no dependencies).
 *   npm run schedule:install            show the task, ask, then create it
 *   npm run schedule:install -- --print show it only
 *   npm run schedule:remove             show what is removed, ask, then remove it
 * The task runs `npm start -- --hunt --no-browser` at the times from Settings → Schedule (default 09:15 and 16:15,
 * Sunday–Thursday; times inside quiet hours are left out), ONLY while you are logged in to Windows: the hunt uses
 * your installed Chrome profile, so there is no "run whether the user is logged on or not".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASK_NAME = 'JobHunter hunt';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULTS = { times: ['09:15', '16:15'], days: [0, 1, 2, 3, 4], quietHours: { from: '22:00', to: '07:00' } };

const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export function inQuiet(t, q) {
  const [x, a, b] = [minutes(t), minutes(q.from), minutes(q.to)];
  if (a === b) return false;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** Settings → Schedule from <DATA_DIR>/settings.json (DATA_DIR from .env), else the defaults. */
export function readSchedule(root = ROOT) {
  let dataDir = 'data';
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    dataDir = /^DATA_DIR=(.+)$/m.exec(env)?.[1]?.trim() || 'data';
  } catch {
    /* no .env yet */
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.resolve(root, dataDir, 'settings.json'), 'utf8')).schedule ?? {};
    return { times: s.times ?? DEFAULTS.times, days: s.days ?? DEFAULTS.days, quietHours: s.quietHours ?? DEFAULTS.quietHours };
  } catch {
    return DEFAULTS;
  }
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The Task Scheduler XML (one weekly trigger per time). */
export function buildTaskXml({ times, days, quietHours, user, root, startDate }) {
  const runnable = times.filter((t) => !inQuiet(t, quietHours));
  const dayTags = days.map((d) => `<${DAY_NAMES[d]} />`).join('');
  const triggers = runnable
    .map(
      (t) => `    <CalendarTrigger>
      <StartBoundary>${startDate}T${t}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek><DaysOfWeek>${dayTags}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>JobHunter</Author>
    <Description>JobHunter: one hunt (discover, score, prepare; it sends only if auto-submit is on and its gate passes). Runs only while you are logged in.</Description>
  </RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\Windows\\System32\\cmd.exe</Command>
      <Arguments>/c npm start -- --hunt --no-browser</Arguments>
      <WorkingDirectory>${xml(root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...flags] = process.argv.slice(2);
  if (process.platform !== 'win32') {
    console.error('Windows Task Scheduler is Windows only. On other systems use the in-app schedule (Settings → Schedule).');
    process.exit(1);
  }
  if (mode === 'install') {
    const s = readSchedule();
    const user = `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;
    const today = new Date();
    const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const taskXml = buildTaskXml({ ...s, user, root: ROOT, startDate });
    const skipped = s.times.filter((t) => inQuiet(t, s.quietHours));
    console.log(`Task Scheduler task "${TASK_NAME}" for ${user}:`);
    console.log(`  runs:     npm start -- --hunt --no-browser   (in ${ROOT})`);
    console.log(`  when:     ${s.times.filter((t) => !inQuiet(t, s.quietHours)).join(', ') || '(no time outside quiet hours!)'} on ${s.days.map((d) => DAY_NAMES[d]).join(', ')}`);
    if (skipped.length) console.log(`  left out: ${skipped.join(', ')} (inside quiet hours ${s.quietHours.from}–${s.quietHours.to})`);
    console.log('  only while you are logged in to Windows (it uses your installed Chrome profile); a missed time is not run later');
    console.log('  it sends applications only if auto-submit is on in Settings and its gate passes\n');
    console.log('The exact task definition:\n');
    console.log(taskXml);
    if (flags.includes('--print')) process.exit(0);
    if (!(await confirm(`Create the task "${TASK_NAME}" now?`))) {
      console.log('Nothing was created.');
      process.exit(0);
    }
    const file = path.join(os.tmpdir(), `jobhunter-task-${process.pid}.xml`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, 'utf16le')]));
    try {
      execFileSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { stdio: 'inherit' });
      console.log(`Created. Remove it with: npm run schedule:remove`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  } else if (mode === 'remove') {
    console.log(`This removes the Task Scheduler task "${TASK_NAME}":  schtasks /Delete /TN "${TASK_NAME}" /F`);
    if (flags.includes('--print')) process.exit(0);
    if (!(await confirm('Remove it now?'))) {
      console.log('Nothing was removed.');
      process.exit(0);
    }
    execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'inherit' });
  } else {
    console.error('usage: node scripts/schedule.mjs install|remove [--print]');
    process.exit(1);
  }
}
