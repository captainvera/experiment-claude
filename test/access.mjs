// Verifies the Cloudflare Access JWT check against real RS256 signatures,
// with the JWKS endpoint stubbed out.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-under-test';
const KID = 'test-key-1';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

// Stand in for https://<team>/cdn-cgi/access/certs
let served = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] };
let certRequests = 0;
globalThis.fetch = async url => {
  certRequests++;
  if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) {
    return new Response('nope', { status: 404 });
  }
  return new Response(JSON.stringify(served), { status: 200, headers: { 'content-type': 'application/json' } });
};

const b64url = bytes => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function makeJwt(claims, opts = {}) {
  const header = { alg: opts.alg || 'RS256', kid: opts.kid || KID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${TEAM}`, aud: [AUD], iat: now, exp: now + 3600, email: 'me@example.com', ...claims };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = opts.corrupt
    ? new Uint8Array(256)
    : new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

const { verifyAccessJwt, normalizeTeam } = await import('../src/worker.js');

console.log('\n— team domain normalisation —');
check('bare team name gets the suffix', normalizeTeam('myteam') === TEAM);
check('full domain is left alone', normalizeTeam(TEAM) === TEAM);
check('https:// prefix is stripped', normalizeTeam(`https://${TEAM}`) === TEAM);
check('trailing slash is stripped', normalizeTeam(`https://${TEAM}/`) === TEAM);
check('empty is null', normalizeTeam('') === null && normalizeTeam(undefined) === null);

console.log('\n— accepts a genuine token —');
const good = await makeJwt({});
const claims = await verifyAccessJwt(good, TEAM, AUD);
check('a valid token verifies', claims !== null);
check('claims come back', claims && claims.email === 'me@example.com');

const beforeCache = certRequests;
await verifyAccessJwt(good, TEAM, AUD);
check('the JWKS is cached, not refetched', certRequests === beforeCache);

console.log('\n— rejects everything else —');
check('a corrupted signature fails', await verifyAccessJwt(await makeJwt({}, { corrupt: true }), TEAM, AUD) === null);
check('an expired token fails', await verifyAccessJwt(await makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }), TEAM, AUD) === null);
check('a not-yet-valid token fails', await verifyAccessJwt(await makeJwt({ nbf: Math.floor(Date.now() / 1000) + 600 }), TEAM, AUD) === null);
check('the wrong audience fails', await verifyAccessJwt(good, TEAM, 'some-other-app') === null);
check('an audience-less token fails', await verifyAccessJwt(await makeJwt({ aud: [] }), TEAM, AUD) === null);
check('the wrong issuer fails', await verifyAccessJwt(await makeJwt({ iss: 'https://evil.cloudflareaccess.com' }), TEAM, AUD) === null);
check('an unknown kid fails', await verifyAccessJwt(await makeJwt({}, { kid: 'not-a-key' }), TEAM, AUD) === null);
check('alg=none is refused', await verifyAccessJwt(await makeJwt({}, { alg: 'none' }), TEAM, AUD) === null);
check('HS256 is refused', await verifyAccessJwt(await makeJwt({}, { alg: 'HS256' }), TEAM, AUD) === null);
check('a malformed token fails', await verifyAccessJwt('garbage', TEAM, AUD) === null);
check('a two-segment token fails', await verifyAccessJwt('a.b', TEAM, AUD) === null);
check('non-base64 segments fail', await verifyAccessJwt('!!!.!!!.!!!', TEAM, AUD) === null);

// A single audience as a bare string, which Access also emits.
check('a string audience is accepted', await verifyAccessJwt(await makeJwt({ aud: AUD }), TEAM, AUD) !== null);

console.log('\n— an unreachable JWKS raises rather than silently allowing —');
let raised = false;
try { await verifyAccessJwt(good, 'unknown.cloudflareaccess.com', AUD) } catch (e) { raised = true }
check('a failed certs fetch throws', raised);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
