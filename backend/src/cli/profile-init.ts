/**
 * npm run profile:init
 * data/profile/cv-he.pdf and/or cv-en.pdf → data/profile/profile.draft.json + profile.conflicts.md
 * (the dashboard's Profile screen does the same with uploads, and diffs against an existing profile instead).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { conflictsMarkdown } from '../profile/merge.js';
import { extractProfile } from '../profile/extract.js';

const dir = config.paths.profileDir;
const files = { he: path.join(dir, 'cv-he.pdf'), en: path.join(dir, 'cv-en.pdf') };
if (!fs.existsSync(files.he) && !fs.existsSync(files.en)) {
  console.error(`put cv-he.pdf and/or cv-en.pdf in ${dir}`);
  process.exit(1);
}
const r = await extractProfile(files, { cache: new Repo(await getDb()), onProgress: (stage, pct) => console.log(`[${String(Math.round(pct)).padStart(3)}%] ${stage}`) });
for (const [l, t] of Object.entries(r.texts)) fs.writeFileSync(path.join(dir, `cv-${l}.txt`), t);

// never lose edits: keep the previous draft
const draft = path.join(dir, 'profile.draft.json');
if (fs.existsSync(draft)) {
  const bak = path.join(dir, `profile.draft.bak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.renameSync(draft, bak);
  console.log(`previous draft kept as ${path.basename(bak)}`);
}
fs.writeFileSync(draft, JSON.stringify(r.profile, null, 2));
fs.writeFileSync(path.join(dir, 'profile.conflicts.md'), conflictsMarkdown(r.conflicts, r.dropped, r.missed));
const p = r.profile;
console.log(
  `\nwrote ${draft}\n      ${path.join(dir, 'profile.conflicts.md')}\n${p.experience.length} roles, ${p.education.length} education, ${p.skills.length} skills; ` +
    `${r.conflicts.filter((c) => c.kind === 'contradiction').length} contradictions, ${r.dropped.length} dropped facts, ${r.missed.length} possibly missed lines.\n` +
    'Review it in the dashboard (Profile screen) and approve it there, or rename it to profile.json.',
);
process.exit(0);
