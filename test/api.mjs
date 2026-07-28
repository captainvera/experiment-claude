// Drives the real API. Start the Worker first: `npm run dev`.
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8788') + '/api';

try {
  await fetch(BASE.replace(/\/api$/, '/'));
} catch (err) {
  console.error(`Could not reach ${BASE.replace(/\/api$/, '')} — is the Worker running?\n\n  npm run dev\n`);
  process.exit(1);
}

let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + JSON.stringify(extra) : '')); }
}

async function call(path, method, token, body) {
  const h = {};
  if (token) h.authorization = 'Bearer ' + token;
  if (body) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json() } catch (e) {}
  return { status: r.status, body: d };
}

const scores = n => ({ communication: n, qualityTime: n, trust: n, intimacy: n, teamwork: n, conflict: n, finances: n, wellbeing: n });
const stats = n => ({ energy: n, mood: n, closeness: n, capacity: n });

console.log('\n— pairing —');
const created = await call('/pair', 'POST', null, { name: 'Miguel', tz: -60 });
check('create pair returns 200', created.status === 200, created);
const { token: tokenA, code } = created.body;
check('create pair returns a token', typeof tokenA === 'string' && tokenA.length > 20);
check('create pair returns a 6-char code', /^[A-Z2-9]{6}$/.test(code), code);

const badCode = await call('/pair/join', 'POST', null, { name: 'Sam', code: 'ZZZZZZ' });
check('join with unknown code is 404', badCode.status === 404, badCode);

const joined = await call('/pair/join', 'POST', null, { name: 'Sam', code, tz: -60 });
check('join with real code returns 200', joined.status === 200, joined);
const tokenB = joined.body.token;
check('joiner gets role b', joined.body.role === 'b');

const third = await call('/pair/join', 'POST', null, { name: 'Interloper', code, tz: -60 });
check('code is closed once both joined (409)', third.status === 409, third);

check('no token is 401', (await call('/state')).status === 401);
check('junk token is 401', (await call('/state', 'GET', 'not-a-real-token')).status === 401);

console.log('\n— the seal —');
let a = await call('/state', 'GET', tokenA);
check('state 200 for A', a.status === 200, a);
check('A sees partner name', a.body.pair.bName === 'Sam', a.body.pair);
check('week starts empty', Object.keys(a.body.week.entries).length === 0, a.body.week);

await call('/checkin', 'POST', tokenA, { scores: scores(9), note: 'A private note from A' });

let b = await call('/state', 'GET', tokenB);
check("B cannot see A's scores before answering", b.body.week.entries.a === undefined, b.body.week.entries);
check('B sees nothing of their own yet', b.body.week.entries.b === undefined);
check('bothIn is false', b.body.week.bothIn === false);
const rawB = JSON.stringify(b.body);
check("A's note appears nowhere in B's payload", !rawB.includes('A private note from A'));

a = await call('/state', 'GET', tokenA);
check('A can see their own answers', a.body.week.entries.a && a.body.week.entries.a.scores.trust === 9);

const revise = await call('/checkin', 'POST', tokenA, { scores: scores(8), note: 'revised' });
check('A may revise before B submits', revise.status === 200, revise);

await call('/checkin', 'POST', tokenB, { scores: scores(4), note: 'B note' });
a = await call('/state', 'GET', tokenA);
check('week opens once both are in', a.body.week.bothIn === true);
check("A now sees B's scores", a.body.week.entries.b && a.body.week.entries.b.scores.trust === 4);
check('revision was kept', a.body.week.entries.a.scores.trust === 8);

const late = await call('/checkin', 'POST', tokenA, { scores: scores(1), note: 'too late' });
check('answers lock once the week is open (409)', late.status === 409, late);

console.log('\n— validation —');
check('out-of-range score rejected', (await call('/checkin', 'POST', tokenB, { scores: scores(11) })).status === 400);
check('missing dimension rejected', (await call('/checkin', 'POST', tokenB, { scores: { communication: 5 } })).status === 400);
check('non-integer score rejected', (await call('/checkin', 'POST', tokenB, { scores: { ...scores(5), trust: 5.5 } })).status === 400);
check('unknown need rejected', (await call('/boo', 'POST', tokenA, { stats: stats(5), need: 'sandwich' })).status === 400);
check('overlong name rejected', (await call('/name', 'POST', tokenA, { name: 'x'.repeat(41) })).status === 400);
check('empty name rejected', (await call('/name', 'POST', tokenA, { name: '   ' })).status === 400);

console.log('\n— boos —');
await call('/boo', 'POST', tokenA, { stats: stats(9), need: 'talk', note: 'shared boo', shared: true });
await call('/boo', 'POST', tokenA, { stats: stats(2), need: 'space', note: 'private boo', shared: false });
b = await call('/state', 'GET', tokenB);
check("B sees A's shared boo", b.body.boo.a && b.body.boo.a.note === 'shared boo', b.body.boo.a);
check("B never sees A's private boo", !JSON.stringify(b.body).includes('private boo'));
a = await call('/state', 'GET', tokenA);
check('A sees their own latest (private) boo', a.body.boo.self.note === 'private boo');
check('unseen: B has not marked A as seen', b.body.boo.seenAt === 0);
await call('/boo/seen', 'POST', tokenB);
b = await call('/state', 'GET', tokenB);
check('seen timestamp recorded', b.body.boo.seenAt > 0);

console.log('\n— word of the day —');
await call('/word', 'POST', tokenA, { word: 'steady extra words' });
b = await call('/state', 'GET', tokenB);
check("B cannot see A's word before picking", b.body.word.entries.a === undefined, b.body.word);
check('word not open', b.body.word.open === false);
await call('/word', 'POST', tokenB, { word: 'tired' });
b = await call('/state', 'GET', tokenB);
check('word opens when both picked', b.body.word.open === true);
check('only the first word is stored', b.body.word.entries.a.word === 'steady', b.body.word.entries.a);
const cleared = await call('/word', 'DELETE', tokenB);
check('clearing returns the old word for editing', cleared.body.word === 'tired', cleared.body);
b = await call('/state', 'GET', tokenB);
check('word closes again after clearing', b.body.word.open === false);

console.log('\n— moments jar —');
await call('/jar', 'POST', tokenA, { text: 'the dog thing' });
await call('/jar', 'POST', tokenB, { text: 'sunday morning' });
a = await call('/state', 'GET', tokenA);
check('jar counts both sides', a.body.jar.mine === 1 && a.body.jar.theirs === 1, a.body.jar);
check('jar items visible once week is open', a.body.jar.items.length === 2);

console.log('\n— history —');
const hist = await call('/history', 'GET', tokenA);
check('history has the completed week', hist.body.weeks.length === 1, hist.body.weeks);
check('history includes both roles', hist.body.weeks[0].data.a && hist.body.weeks[0].data.b);

console.log('\n— sign out —');
await call('/signout', 'POST', tokenB);
check('token is dead after sign out', (await call('/state', 'GET', tokenB)).status === 401);
check("A's session survives B signing out", (await call('/state', 'GET', tokenA)).status === 200);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
