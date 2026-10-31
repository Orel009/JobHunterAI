import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrate } from '../db/index.js';

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
const ran = migrate(new DatabaseSync(config.paths.db));
console.log(`DB: ${config.paths.db}\napplied: ${ran.length ? ran.join(', ') : '(none pending)'}`);
