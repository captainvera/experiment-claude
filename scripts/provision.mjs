#!/usr/bin/env node
/**
 * Makes sure the D1 database exists and that wrangler.jsonc points at it.
 *
 * Idempotent, so it can run before every deploy — locally from setup.sh or in
 * CI. This is what lets the whole thing be published without anyone editing a
 * config file by hand: the database id is resolved at deploy time rather than
 * being something a human has to copy across.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DB_NAME = 'togetherly';
const CONFIG = 'wrangler.jsonc';

const wrangler = (args, inherit) => execFileSync('npx', ['wrangler', ...args], {
  encoding: 'utf8',
  stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
});

/** `wrangler d1 list --json` can emit a banner before the JSON, so find it. */
function listDatabases() {
  const out = wrangler(['d1', 'list', '--json']);
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`Unexpected output from 'wrangler d1 list':\n${out}`);
  return JSON.parse(out.slice(start));
}

function fatal(message, err) {
  console.error(`\n${message}`);
  const detail = err && (err.stderr || err.message);
  if (detail) console.error(`\n${String(detail).trim()}`);
  process.exit(1);
}

let databases;
try {
  databases = listDatabases();
} catch (err) {
  fatal(
    'Could not reach Cloudflare.\n' +
    '  Locally: run `npx wrangler login`.\n' +
    '  In CI:   check the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets.',
    err,
  );
}

let db = databases.find(d => d.name === DB_NAME);
if (db) {
  console.log(`Database "${DB_NAME}" already exists.`);
} else {
  console.log(`Creating database "${DB_NAME}"…`);
  try {
    wrangler(['d1', 'create', DB_NAME], true);
  } catch (err) {
    fatal(`Could not create the database "${DB_NAME}".`, err);
  }
  db = listDatabases().find(d => d.name === DB_NAME);
}

const id = db && (db.uuid || db.database_id || db.id);
if (!id) fatal(`Created "${DB_NAME}" but could not read its id back. Run 'npx wrangler d1 list'.`);

const config = readFileSync(CONFIG, 'utf8');
const updated = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
if (updated === config) {
  console.log(`${CONFIG} already points at ${id}.`);
} else {
  writeFileSync(CONFIG, updated);
  console.log(`Pointed ${CONFIG} at database ${id}.`);
}
