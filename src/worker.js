/**
 * Togetherly API.
 *
 * The one rule this server exists to enforce: neither partner can see the
 * other's answers early. The original prototype kept both people's answers in
 * one blob and simply declined to render the half you weren't allowed to see —
 * which meant the data was on your device the whole time. Here, sealed data
 * never leaves the database. See docs/architecture.md.
 */

const DIMS = [
  'communication', 'qualityTime', 'trust', 'intimacy',
  'teamwork', 'conflict', 'finances', 'wellbeing',
];
const STATS = ['energy', 'mood', 'closeness', 'capacity'];
const NEEDS = ['space', 'affection', 'talk', 'help', 'laugh', 'company'];

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no look-alikes
const MAX_NAME = 40;
const MAX_NOTE = 2000;
const MAX_WORD = 18;
const MAX_MOMENT = 140;
const MAX_JAR_PER_WEEK = 100;
const WORD_OPENS_AT_HOUR = 21;
const JOIN_FAIL_LIMIT = 10;
const JOIN_LOCKOUT_MS = 15 * 60 * 1000;

/* --------------------------------------------------- cloudflare access */

/**
 * Optional gate in front of everything, including the static page.
 *
 * Access already blocks unauthenticated requests at the edge for the hostname
 * you attach the policy to — but the Worker keeps answering on its
 * *.workers.dev address, which no Access policy covers. So the Worker verifies
 * the assertion itself. That closes the bypass wherever the request arrives.
 *
 * Inert until ACCESS_TEAM_DOMAIN and ACCESS_AUD are both set, so an
 * unconfigured deployment behaves exactly as before.
 */

const JWKS_TTL = 60 * 60 * 1000;
let jwksCache = { at: 0, team: null, keys: null };

/** Accepts "myteam", "myteam.cloudflareaccess.com" or a full URL. */
function normalizeTeam(raw) {
  const value = String(raw || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!value) return null;
  return value.includes('.') ? value : `${value}.cloudflareaccess.com`;
}

function b64urlBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const decodeSegment = segment => JSON.parse(new TextDecoder().decode(b64urlBytes(segment)));

async function accessKeys(team) {
  const fresh = jwksCache.keys && jwksCache.team === team && Date.now() - jwksCache.at < JWKS_TTL;
  if (fresh) return jwksCache.keys;

  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs returned ${res.status}`);
  const { keys } = await res.json();
  if (!Array.isArray(keys) || !keys.length) throw new Error('Access certs contained no keys');

  jwksCache = { at: Date.now(), team, keys };
  return keys;
}

async function verifyAccessJwt(token, team, aud) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header, payload;
  try {
    header = decodeSegment(rawHeader);
    payload = decodeSegment(rawPayload);
  } catch (err) {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(rawSignature), signed);
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${team}`) return null;

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;

  return payload;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function accessDenied(isApi, message, status) {
  if (isApi) return json({ error: message }, status);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Togetherly</title>` +
    `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1A1216;color:#F6EDE6;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:24px">` +
    `<div style="max-width:22rem"><h1 style="font:400 28px Georgia,serif;margin:0 0 12px">Togetherly</h1>` +
    `<p style="color:#A6919B;line-height:1.6;margin:0">${message}</p></div></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

/**
 * Returns a Response to block the request, or null to let it through.
 */
async function accessGate(request, env, isApi) {
  const team = normalizeTeam(env.ACCESS_TEAM_DOMAIN);
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) return null;

  const token = request.headers.get('cf-access-jwt-assertion') || readCookie(request, 'CF_Authorization');
  if (!token) {
    return accessDenied(isApi, 'This app is protected by Cloudflare Access. Open it through your Access-protected address and sign in.', 401);
  }

  let claims;
  try {
    claims = await verifyAccessJwt(token, team, aud);
  } catch (err) {
    // A JWKS fetch failure is our problem, not the visitor's — say so rather
    // than implying they are unauthorised.
    console.error('access verification failed', err && err.stack);
    return accessDenied(isApi, 'Could not check your sign-in just now. Please try again in a moment.', 503);
  }
  if (!claims) {
    return accessDenied(isApi, 'Your Access session is not valid for this app. Sign in again.', 403);
  }
  return null;
}

// Exported for tests; the Worker itself only ever uses accessGate().
export { verifyAccessJwt, normalizeTeam };

/* -------------------------------------------------------------- plumbing */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new ApiError(status, message); };

const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  // 256 is a multiple of 32, so the modulo introduces no bias.
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return b64url(new Uint8Array(digest));
}

/* ------------------------------------------------------------ validation */

function str(value, max, field) {
  if (typeof value !== 'string') fail(400, `${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(400, `${field} is too long (max ${max} characters)`);
  return trimmed;
}

function requiredStr(value, max, field) {
  const trimmed = str(value, max, field);
  if (!trimmed) fail(400, `${field} is required`);
  return trimmed;
}

function scoreSet(value, keys, field) {
  if (!value || typeof value !== 'object') fail(400, `${field} is missing`);
  const out = {};
  for (const key of keys) {
    const n = value[key];
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      fail(400, `${field}.${key} must be a whole number from 1 to 10`);
    }
    out[key] = n;
  }
  return out;
}

function tzOffset(value) {
  const n = Number(value);
  // Real offsets span -840..720; anything else is a broken or hostile client.
  if (!Number.isFinite(n) || n < -840 || n > 720) return 0;
  return Math.round(n);
}

/* ------------------------------------------------------------- calendars */

const pad2 = n => String(n).padStart(2, '0');

/** Wall-clock time for the pair, as a Date whose UTC fields read as local. */
const localOf = (now, offset) => new Date(now - offset * 60000);

function dayIdOf(now, offset) {
  const d = localOf(now, offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Monday of the pair's current local week, as YYYY-MM-DD. */
function weekIdOf(now, offset) {
  const d = localOf(now, offset);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const localHourOf = (now, offset) => localOf(now, offset).getUTCHours();

/* ----------------------------------------------------------------- shapes */

const checkinOut = row => ({
  scores: JSON.parse(row.scores),
  note: row.note,
  at: row.at,
});

const booOut = row => (row ? {
  stats: JSON.parse(row.stats),
  need: row.need,
  note: row.note,
  at: row.at,
  shared: row.kind === 'shared',
} : null);

const other = role => (role === 'a' ? 'b' : 'a');

/* -------------------------------------------------------------- endpoints */

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) fail(401, 'Not signed in');

  const tokenHash = await hashToken(match[1]);
  const device = await env.DB.prepare(
    `SELECT d.token_hash, d.code, d.role,
            p.a_name, p.b_name, p.tz_offset, p.created_at, p.b_joined_at
       FROM devices d
       JOIN pairs p ON p.code = d.code
      WHERE d.token_hash = ?`,
  ).bind(tokenHash).first();
  if (!device) fail(401, 'Not signed in');

  return {
    tokenHash,
    code: device.code,
    role: device.role,
    pair: {
      code: device.code,
      aName: device.a_name,
      bName: device.b_name,
      createdAt: device.created_at,
      paired: device.b_joined_at != null,
    },
    tz: device.tz_offset,
  };
}

async function createPair(request, env, now) {
  const body = await readJson(request);
  const name = requiredStr(body.name, MAX_NAME, 'name');
  const tz = tzOffset(body.tz);
  const token = newToken();

  // Six characters from a 32-symbol alphabet is ~1.07e9 codes. Collisions are
  // vanishingly unlikely, but a duplicate would hand someone else's pair to a
  // stranger, so retry rather than trust the odds.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO pairs (code, a_name, tz_offset, created_at) VALUES (?, ?, ?, ?)',
        ).bind(code, name, tz, now),
        env.DB.prepare(
          'INSERT INTO devices (token_hash, code, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(await hashToken(token), code, 'a', now, now),
      ]);
      return json({ token, role: 'a', code });
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
    }
  }
  fail(503, 'Could not create a pair just now. Please try again.');
}

async function joinPair(request, env, now, ip) {
  const body = await readJson(request);
  const name = requiredStr(body.name, MAX_NAME, 'name');
  const code = requiredStr(body.code, 6, 'code').toUpperCase();

  const throttle = await env.DB.prepare(
    'SELECT fails, until FROM join_attempts WHERE ip = ?',
  ).bind(ip).first();
  if (throttle && throttle.until > now) {
    fail(429, 'Too many attempts. Try again in a few minutes.');
  }

  const pair = await env.DB.prepare(
    'SELECT code, b_joined_at FROM pairs WHERE code = ?',
  ).bind(code).first();

  if (!pair) {
    const fails = ((throttle && throttle.until > now ? throttle.fails : 0) || 0) + 1;
    const until = fails >= JOIN_FAIL_LIMIT ? now + JOIN_LOCKOUT_MS : 0;
    await env.DB.prepare(
      `INSERT INTO join_attempts (ip, fails, until) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fails = ?, until = ?`,
    ).bind(ip, fails, until, fails, until).run();
    fail(404, 'No pair found with that code. Check the letters and try again.');
  }

  // A pairing code is an invite, not a password: once both people are in, it
  // stops working. Otherwise anyone who ever saw the code could join later and
  // read everything.
  if (pair.b_joined_at != null) {
    fail(409, 'That pair is already complete. Ask your partner to sign you in from their device.');
  }

  const token = newToken();
  await env.DB.batch([
    env.DB.prepare('UPDATE pairs SET b_name = ?, b_joined_at = ? WHERE code = ? AND b_joined_at IS NULL')
      .bind(name, now, code),
    env.DB.prepare('INSERT INTO devices (token_hash, code, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashToken(token), code, 'b', now, now),
    env.DB.prepare('DELETE FROM join_attempts WHERE ip = ?').bind(ip),
  ]);
  return json({ token, role: 'b', code });
}

async function getState(env, session, now) {
  const { code, role, tz } = session;
  const week = weekIdOf(now, tz);
  const day = dayIdOf(now, tz);
  const mate = other(role);

  const [checkins, nudge, boos, seen, words, jar] = await env.DB.batch([
    env.DB.prepare('SELECT role, scores, note, at FROM checkins WHERE code = ? AND week = ?').bind(code, week),
    env.DB.prepare('SELECT role, at FROM nudges WHERE code = ? AND week = ?').bind(code, week),
    env.DB.prepare('SELECT role, kind, stats, need, note, at FROM boos WHERE code = ?').bind(code),
    env.DB.prepare('SELECT at FROM boo_seen WHERE code = ? AND role = ?').bind(code, role),
    env.DB.prepare('SELECT role, word, at FROM words WHERE code = ? AND day = ?').bind(code, day),
    env.DB.prepare('SELECT role, text, at FROM jar WHERE code = ? AND week = ? ORDER BY id').bind(code, week),
  ]);

  const rows = checkins.results;
  const mineWeek = rows.find(r => r.role === role);
  const theirsWeek = rows.find(r => r.role === mate);
  const bothIn = Boolean(mineWeek && theirsWeek);

  // The seal. Their answers are withheld here, not hidden in the UI.
  const entries = {};
  if (mineWeek) entries[role] = checkinOut(mineWeek);
  if (bothIn) entries[mate] = checkinOut(theirsWeek);
  const nudgeRow = nudge.results[0];
  if (nudgeRow) {
    entries.nudgedBy = nudgeRow.role;
    entries.nudgedAt = nudgeRow.at;
  }

  const booRows = boos.results;
  const pick = (r, kind) => booRows.find(x => x.role === r && x.kind === kind) || null;

  const wordRows = words.results;
  const myWord = wordRows.find(r => r.role === role);
  const theirWord = wordRows.find(r => r.role === mate);
  const wordOpen = Boolean(
    (myWord && theirWord) || (localHourOf(now, tz) >= WORD_OPENS_AT_HOUR && (myWord || theirWord)),
  );
  const wordEntries = {};
  if (myWord) wordEntries[role] = { word: myWord.word, at: myWord.at };
  if (theirWord && wordOpen) wordEntries[mate] = { word: theirWord.word, at: theirWord.at };

  // Jar items follow the same seal as the week: you always see your own, your
  // partner's arrive when the week opens.
  const jarRows = jar.results;
  const jarItems = jarRows
    .filter(r => bothIn || r.role === role)
    .map(r => ({ by: r.role, text: r.text, at: r.at }));

  return json({
    role,
    pair: session.pair,
    you: { name: role === 'a' ? session.pair.aName : session.pair.bName },
    // `submitted` says *that* each of you has answered without saying what you
    // said. Without it a sealed week would look identical to an empty one, and
    // neither of you could tell you were the one holding things up.
    week: {
      id: week,
      entries,
      bothIn,
      submitted: { a: rows.some(r => r.role === 'a'), b: rows.some(r => r.role === 'b') },
    },
    boo: {
      self: booOut(pick(role, 'self')) || booOut(pick(role, 'shared')),
      a: booOut(pick('a', 'shared')),
      b: booOut(pick('b', 'shared')),
      seenAt: (seen.results[0] && seen.results[0].at) || 0,
    },
    word: { day, entries: wordEntries, open: wordOpen },
    jar: {
      items: jarItems,
      mine: jarRows.filter(r => r.role === role).length,
      theirs: jarRows.filter(r => r.role === mate).length,
    },
    now,
  });
}

async function getHistory(env, session, now) {
  const { code, role, tz } = session;
  const mate = other(role);

  const weeks = await env.DB.prepare(
    `SELECT week, role, scores, note, at
       FROM checkins
      WHERE code = ?
        AND week IN (
          SELECT week FROM checkins WHERE code = ? GROUP BY week HAVING COUNT(DISTINCT role) = 2
          ORDER BY week DESC LIMIT 12
        )
      ORDER BY week`,
  ).bind(code, code).all();

  const byWeek = new Map();
  for (const row of weeks.results) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, { id: row.week, data: {} });
    byWeek.get(row.week).data[row.role] = checkinOut(row);
  }

  const words = await env.DB.prepare(
    `SELECT day, role, word, at
       FROM words
      WHERE code = ?
        AND day IN (
          SELECT day FROM words WHERE code = ? GROUP BY day HAVING COUNT(DISTINCT role) = 2
          ORDER BY day DESC LIMIT 8
        )
      ORDER BY day`,
  ).bind(code, code).all();

  const byDay = new Map();
  for (const row of words.results) {
    if (!byDay.has(row.day)) byDay.set(row.day, { id: row.day, data: {} });
    byDay.get(row.day).data[row.role] = { word: row.word, at: row.at };
  }

  // Today is still in play; the client renders it from /state, not history.
  const today = dayIdOf(now, tz);
  return json({
    weeks: [...byWeek.values()],
    words: [...byDay.values()].filter(w => w.id !== today),
    role,
    mate,
  });
}

async function saveCheckin(request, env, session, now) {
  const body = await readJson(request);
  const scores = scoreSet(body.scores, DIMS, 'scores');
  const note = str(body.note || '', MAX_NOTE, 'note');
  const week = weekIdOf(now, session.tz);

  // You may revise your answers right up until your partner submits; after
  // that the week is open and the record stands.
  const locked = await env.DB.prepare(
    'SELECT 1 AS x FROM checkins WHERE code = ? AND week = ? AND role = ?',
  ).bind(session.code, week, other(session.role)).first();
  const existing = await env.DB.prepare(
    'SELECT 1 AS x FROM checkins WHERE code = ? AND week = ? AND role = ?',
  ).bind(session.code, week, session.role).first();
  if (locked && existing) {
    fail(409, 'This week is already open. Your answers are locked in.');
  }

  await env.DB.prepare(
    `INSERT INTO checkins (code, week, role, scores, note, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(code, week, role) DO UPDATE SET scores = ?, note = ?, at = ?`,
  ).bind(
    session.code, week, session.role, JSON.stringify(scores), note, now,
    JSON.stringify(scores), note, now,
  ).run();

  return json({ ok: true });
}

async function saveNudge(env, session, now) {
  const week = weekIdOf(now, session.tz);
  await env.DB.prepare(
    `INSERT INTO nudges (code, week, role, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(code, week) DO UPDATE SET role = ?, at = ?`,
  ).bind(session.code, week, session.role, now, session.role, now).run();
  return json({ ok: true });
}

async function saveBoo(request, env, session, now) {
  const body = await readJson(request);
  const stats = scoreSet(body.stats, STATS, 'stats');
  const note = str(body.note || '', MAX_NOTE, 'note');
  const shared = body.shared === true;
  let need = body.need == null ? null : str(body.need, 20, 'need');
  if (need && !NEEDS.includes(need)) fail(400, 'need is not one of the available options');

  const write = kind => env.DB.prepare(
    `INSERT INTO boos (code, role, kind, stats, need, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code, role, kind) DO UPDATE SET stats = ?, need = ?, note = ?, at = ?`,
  ).bind(
    session.code, session.role, kind, JSON.stringify(stats), need, note, now,
    JSON.stringify(stats), need, note, now,
  );

  // Saving privately updates your own creature only. Your partner keeps seeing
  // the last Boo you deliberately shared.
  const statements = [write('self')];
  if (shared) statements.push(write('shared'));
  await env.DB.batch(statements);

  return json({ ok: true });
}

async function markBooSeen(env, session, now) {
  await env.DB.prepare(
    `INSERT INTO boo_seen (code, role, at) VALUES (?, ?, ?)
     ON CONFLICT(code, role) DO UPDATE SET at = ?`,
  ).bind(session.code, session.role, now, now).run();
  return json({ ok: true });
}

async function saveWord(request, env, session, now) {
  const body = await readJson(request);
  const word = requiredStr(body.word, MAX_WORD, 'word').split(/\s+/)[0];
  if (!word) fail(400, 'word is required');
  const day = dayIdOf(now, session.tz);

  await env.DB.prepare(
    `INSERT INTO words (code, day, role, word, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code, day, role) DO UPDATE SET word = ?, at = ?`,
  ).bind(session.code, day, session.role, word, now, word, now).run();

  return json({ ok: true });
}

async function clearWord(env, session, now) {
  const day = dayIdOf(now, session.tz);
  const row = await env.DB.prepare(
    'SELECT word FROM words WHERE code = ? AND day = ? AND role = ?',
  ).bind(session.code, day, session.role).first();

  await env.DB.prepare(
    'DELETE FROM words WHERE code = ? AND day = ? AND role = ?',
  ).bind(session.code, day, session.role).run();

  return json({ ok: true, word: (row && row.word) || '' });
}

async function addMoment(request, env, session, now) {
  const body = await readJson(request);
  const text = requiredStr(body.text, MAX_MOMENT, 'text');
  const week = weekIdOf(now, session.tz);

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM jar WHERE code = ? AND week = ? AND role = ?',
  ).bind(session.code, week, session.role).first();
  if (count.n >= MAX_JAR_PER_WEEK) fail(409, 'The jar is full for this week.');

  await env.DB.prepare(
    'INSERT INTO jar (code, week, role, text, at) VALUES (?, ?, ?, ?, ?)',
  ).bind(session.code, week, session.role, text, now).run();

  return json({ ok: true });
}

async function saveName(request, env, session) {
  const body = await readJson(request);
  const name = requiredStr(body.name, MAX_NAME, 'name');
  const column = session.role === 'a' ? 'a_name' : 'b_name';
  await env.DB.prepare(`UPDATE pairs SET ${column} = ? WHERE code = ?`).bind(name, session.code).run();
  return json({ ok: true, name });
}

async function signOut(env, session) {
  await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(session.tokenHash).run();
  return json({ ok: true });
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') fail(400, 'Expected a JSON object');
    return body;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail(400, 'Expected a JSON object');
  }
}

/* ----------------------------------------------------------------- router */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (path === '/api/pair' && method === 'POST') return createPair(request, env, now);
  if (path === '/api/pair/join' && method === 'POST') return joinPair(request, env, now, ip);

  const session = await authenticate(request, env);
  ctx.waitUntil(env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?')
    .bind(now, session.tokenHash).run());

  if (path === '/api/state' && method === 'GET') return getState(env, session, now);
  if (path === '/api/history' && method === 'GET') return getHistory(env, session, now);
  if (path === '/api/checkin' && method === 'POST') return saveCheckin(request, env, session, now);
  if (path === '/api/nudge' && method === 'POST') return saveNudge(env, session, now);
  if (path === '/api/boo' && method === 'POST') return saveBoo(request, env, session, now);
  if (path === '/api/boo/seen' && method === 'POST') return markBooSeen(env, session, now);
  if (path === '/api/word' && method === 'POST') return saveWord(request, env, session, now);
  if (path === '/api/word' && method === 'DELETE') return clearWord(env, session, now);
  if (path === '/api/jar' && method === 'POST') return addMoment(request, env, session, now);
  if (path === '/api/name' && method === 'POST') return saveName(request, env, session);
  if (path === '/api/signout' && method === 'POST') return signOut(env, session);

  fail(404, 'No such endpoint');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');

    const blocked = await accessGate(request, env, isApi);
    if (blocked) return blocked;

    if (!isApi) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      console.error('unhandled', err && err.stack);
      return json({ error: 'Something went wrong on our side.' }, 500);
    }
  },
};
