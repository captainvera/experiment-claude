# Architecture

## The question this repo started from

> Does the artifact have the makeshift backend logic, or can you infer the
> backend functionality of it?

Both, in a sense. The original single-file artifact contained **no backend
code at all** — but it described one precisely enough to rebuild, because every
read and write went through one narrow seam:

```js
const store = (() => { try { return window.storage || null } catch (e) { return null } })();

async function sget(k, sh) { const r = await store.get(k, !!sh); return r ? JSON.parse(r.value) : null }
async function sset(k, v, sh) { await store.set(k, JSON.stringify(v), !!sh) }
async function slist(p, sh) { const r = await store.list(p, !!sh); return (r && r.keys) || [] }
```

That is the whole data layer. It assumes a host-provided key/value store with
three operations — `get`, `set`, `list(prefix)` — where every call takes a
second argument: a `shared` boolean choosing between a **private** namespace
(this viewer only) and a **shared** one (visible to everyone with the page).

The "makeshift" part is the fallback. When `window.storage` is absent — which
is what happens if you open the file as plain HTML — it silently degrades to
`const mem = new Map()`. The app runs, looks completely functional, and loses
everything on refresh. There is no partner, no sync, no persistence.

## The backend the artifact implied

The key layout was fully recoverable from the code:

| Key | Scope | Contents |
| --- | --- | --- |
| `togetherly:profile` | private | `{name, role: 'a'\|'b', code}` |
| `togetherly:pair:<CODE>:meta` | shared | `{aName, bName, createdAt}` |
| `togetherly:pair:<CODE>:week:<YYYY-MM-DD>` | shared | `{a: {scores, note, at}, b: {…}, nudgedBy, nudgedAt}` |
| `togetherly:pair:<CODE>:boo:<a\|b>` | shared | `{stats, need, note, at, shared}` |
| `togetherly:pair:<CODE>:word:<YYYY-MM-DD>` | shared | `{a: {word, at}, b: {…}}` |
| `togetherly:pair:<CODE>:jar:<WEEK>` | shared | `{items: [{by, text, at}]}` |
| `togetherly:boo:self` | private | your latest Boo, shared or not |
| `togetherly:boo:seen` | private | timestamp of the last partner Boo you saw |

Identity was a self-assigned role: whoever tapped "Start a new pair" became
`a`, whoever entered the code became `b`. Sync was a 20-second `setInterval`
re-reading the shared keys, plus a re-read on window focus. No push, no
sockets, no server-side anything.

## Five things that model got wrong

Worth stating plainly, because the rebuild exists to fix them.

1. **The seal was cosmetic.** The app's central promise — "neither of you sees
   the answers until you have both finished" — was enforced by `vHome()`
   declining to render half of an object that was already on your device. Both
   partners' answers lived in one shared key, so the sealed half was one
   DevTools console line away the whole time.

2. **The pairing code was a permanent password.** Anyone who ever saw the six
   characters could read and write everything, forever. `join` also blindly
   overwrote `bName`, so a third person with the code could install themselves
   as partner B.

3. **Concurrent writes clobbered.** Every mutation was read-modify-write on a
   whole document held in memory since the last poll. Two people submitting
   inside the same 20-second window meant one of them silently lost their
   answers. The jar (`jarItems().concat(...)`) had the same shape of bug.

4. **Time came from the device.** The daily word unlocking "at nine" and the
   48-hour Boo staleness check both read the local clock. Changing your phone's
   time changed what you were allowed to see.

5. **Nothing could be left.** Signing out cleared the local profile only; the
   shared pair data stayed behind with no way to reach or delete it.

## What this repo runs instead

Same app, same UI, real backend. Three Cloudflare pieces and nothing else:

```
  browser ──▶ Workers Static Assets ──▶ public/index.html
       │
       └────▶ Worker (src/worker.js) ──▶ D1 (SQLite)
                  /api/*
```

- **Static assets** serve the page straight from the edge. `run_worker_first`
  is scoped to `/api/*`, so a page load costs no Worker invocation.
- **The Worker** is the only thing that touches data, and it is where every
  rule now lives.
- **D1** stores it. One row per partner per artefact, so the two of you cannot
  overwrite each other.

### How the five problems are handled now

**The seal is real.** `GET /api/state` builds its response from what you are
entitled to see. Until both check-ins exist for the week, your partner's row is
never read into the response at all — it is not hidden in the client, it is
absent from the wire. The browser test in this repo asserts exactly that: it
searches the raw JSON payload for the partner's note and requires it to be
missing.

The one thing the server *does* reveal early is `week.submitted`, a pair of
booleans saying **that** each of you has answered without saying **what**.
Without it a sealed week is indistinguishable from an empty one and neither
partner can tell who is holding things up.

**Pairing codes are invites, not passwords.** A code works exactly once. The
moment partner B joins, `b_joined_at` is set and the code is closed — a third
party who learns it later gets a 409. Sessions then run on 32-byte bearer
tokens stored only as SHA-256 hashes, so a database dump cannot be replayed.
Wrong-code attempts are rate limited per IP.

**Writes cannot clobber.** `checkins`, `words` and `boos` are keyed by
`(pair, period, role)`, so each partner writes their own row. The jar is
append-only. You may revise your own answers freely until your partner submits;
after that the week is open and the record stands.

**Time comes from the server.** The pair's timezone offset is stored once at
creation and every week/day boundary and unlock is computed server-side from
`Date.now()`. A client that lies about its clock changes nothing.

**Sessions can be ended.** `POST /api/signout` deletes that device's row.
Other devices on the same account keep working.

### Cloudflare Access (optional)

The app's own auth protects the *data*: without a pairing code or a session
token there is nothing to see. It does not protect the *page*, which loads for
anyone with the link. Setting `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` puts
Cloudflare Access in front of everything, page included.

The Worker verifies the `Cf-Access-Jwt-Assertion` (or `CF_Authorization`
cookie) itself — fetching the team's JWKS, checking the RS256 signature, `exp`,
`nbf`, `iss` and `aud`, and caching the keys for an hour. This is not
redundant. Access only guards the hostname its policy is attached to, and the
Worker keeps answering on its `*.workers.dev` address, which no Access policy
covers. Checking in the Worker means the gate holds wherever the request
arrives.

Consequently `run_worker_first` is `true` rather than scoped to `/api/*`.
Serving the page directly from the asset layer would be marginally cheaper, but
the Worker would never see those requests and so could never gate them.

With both variables empty the check is skipped entirely, so an unconfigured
deployment behaves exactly as it did before.

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/pair` | Create a pair, become partner A. Returns a token and code. |
| `POST` | `/api/pair/join` | Redeem a code once, become partner B. Rate limited. |
| `GET` | `/api/state` | Everything you are entitled to see right now. |
| `GET` | `/api/history` | Last 12 completed weeks and 8 revealed word-days. |
| `POST` | `/api/checkin` | Your weekly scores and note. Locks when the week opens. |
| `POST` | `/api/nudge` | Nudge your partner. |
| `POST` | `/api/boo` | Save a Boo, privately or shared. |
| `POST` | `/api/boo/seen` | Mark your partner's Boo as read. |
| `POST` `/` `DELETE` | `/api/word` | Set or clear today's word. |
| `POST` | `/api/jar` | Add a moment. |
| `POST` | `/api/name` | Rename yourself. |
| `POST` | `/api/signout` | Revoke this device's token. |

All routes except the two pairing calls require `Authorization: Bearer <token>`.

### What did not change

`public/index.html` is still the artifact: same markup, same CSS, same views,
same SVG creatures. Only the data layer was replaced — `sget`/`sset`/`slist`
became an `api()` helper and `pull()` now maps one `/api/state` response into
the shape the existing views already expected. Sealed data simply arrives as
`undefined`, which is precisely the case those views were already written to
handle.

## Known limits

- **No account recovery.** Losing every signed-in device means losing the pair;
  there is no email on file to recover it with. Deliberate for a two-person
  app, but worth knowing before it bites.
- **Adding a second device** means signing in on it, and the only path is the
  pairing code — which closes after B joins. In practice each partner uses one
  device. A proper "sign in my other device" flow is the obvious next feature.
- **Polling, not push.** State refreshes every 20 seconds, on tab change and on
  window focus. Fine at this scale; a Durable Object per pair with a WebSocket
  is the upgrade path if it ever needs to feel instant.
- **No delete-my-data endpoint.** The schema uses `ON DELETE CASCADE` from
  `pairs`, so it is one statement away, but nothing exposes it yet.
