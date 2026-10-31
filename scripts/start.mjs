#!/usr/bin/env node
/**
 * Entry point for `npm start` / `npm run doctor` / start.cmd.
 * Plain Node with no dependencies, so it can run before `npm install`:
 *   check 1 — Node version + dependencies (installs them when node_modules is missing or the lockfile changed)
 * then registers tsx and hands over to backend/src/cli/start.ts for checks 2–8.
 *
 *   node scripts/start.mjs            start everything
 *   node scripts/start.mjs --hunt     start, then run one discover → score → prepare pass
 *   node scripts/start.mjs --doctor   checks 1–6 only, changes nothing
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const doctor = args.includes('--doctor');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function fail(he, en, fixHe, fixEn) {
  console.error(`\n${red('✗')} ${en}\n  ${he}`);
  if (fixEn) console.error(`  → ${fixEn}\n  → ${fixHe}`);
  process.exit(1);
}

// ---- 1a. Node version (node:sqlite without a flag needs 22.13+) ----
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  fail(`גרסת Node ${process.versions.node} ישנה מדי (נדרש 22.13 ומעלה)`, `Node ${process.versions.node} is too old (need 22.13+)`, 'יש להתקין Node LTS מ-https://nodejs.org', 'Install Node LTS from https://nodejs.org');
}
console.log(`${green('✓')} Node ${process.versions.node}`);

// ---- 1b. dependencies ----
const nm = path.join(ROOT, 'node_modules');
const hiddenLock = path.join(nm, '.package-lock.json'); // written by npm after every install
const lock = path.join(ROOT, 'package-lock.json');
const missing = !fs.existsSync(path.join(nm, 'tsx')) || !fs.existsSync(hiddenLock);
const stale = !missing && fs.existsSync(lock) && fs.statSync(lock).mtimeMs > fs.statSync(hiddenLock).mtimeMs + 1000;
if (missing || stale) {
  const why = missing ? 'node_modules missing' : 'package-lock.json changed';
  if (doctor) {
    fail(`חבילות לא מותקנות / לא מעודכנות (${why})`, `Dependencies are not installed or out of date (${why})`, 'יש להריץ npm install', 'Run: npm install');
  }
  console.log(`… ${why} → npm install`);
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    fail('npm install נכשל', 'npm install failed', 'יש לבדוק את החיבור לאינטרנט ולהריץ שוב npm install', 'Check your internet connection and run npm install again');
  }
}
console.log(`${green('✓')} dependencies installed`);

// ---- hand over to TypeScript (checks 2–8) ----
const { register } = await import(pathToFileURL(path.join(nm, 'tsx', 'dist', 'esm', 'api', 'index.mjs')).href);
register();
await import(pathToFileURL(path.join(ROOT, 'backend', 'src', 'cli', 'start.ts')).href);
