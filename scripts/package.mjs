#!/usr/bin/env node
/**
 * npm run package → dist/JobHunter-<version>.zip, for sharing without GitHub access.
 * Contains only git-tracked files at HEAD (git archive), so data/, .env, CVs and the DB can't get in;
 * the finished zip is then read back and checked for them anyway.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `JobHunter-${version}`;
const out = path.join(ROOT, 'dist', `${name}.zip`);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** Paths that must never be shared. */
export function forbidden(p) {
  const f = p.replace(/\\/g, '/').toLowerCase();
  const base = f.split('/').pop() ?? '';
  return (
    /(^|\/)data\//.test(f) ||
    /(^|\/)browser-profile\//.test(f) ||
    (base.startsWith('.env') && base !== '.env.example') ||
    /\.(pdf|db|sqlite\d?|sqlite-wal|sqlite-shm)$/.test(base) ||
    base === 'preferences.yaml'
  );
}

/** Entry names from a zip's central directory (no dependencies). */
function zipEntries(file) {
  const b = fs.readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('broken central directory');
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    names.push(b.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirty = git('status', '--porcelain', '--untracked-files=no').trim();
  if (dirty) console.log('! uncommitted changes are NOT included (the zip is built from the last commit)');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  git('archive', '--format=zip', `--prefix=${name}/`, '-o', out, 'HEAD');

  const entries = zipEntries(out);
  const bad = entries.filter(forbidden);
  if (bad.length) {
    fs.rmSync(out);
    console.error(`✗ the zip would contain personal files, deleted it:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  const files = entries.filter((e) => !e.endsWith('/'));
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`✓ ${path.relative(ROOT, out)} — ${files.length} files, ${kb} KB, commit ${git('rev-parse', '--short', 'HEAD').trim()}`);
  console.log('✓ checked: no data/, .env, PDF, database or preferences.yaml inside');
}
