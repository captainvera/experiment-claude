# Togetherly

A weekly check-in for the two of you. Eight questions, once a week. Neither
partner sees the other's answers until both have finished.

Alongside the weekly ritual there are **Boos** (a small creature showing how
you are today, shareable or private), a **word of the day** that unlocks when
you have both picked or at nine in the evening, a **moments jar** that opens
with the week, and **seasons** — every twelve weeks the app writes you a letter
about what actually changed.

Runs entirely on Cloudflare: a Worker for the API, D1 for storage, and Workers
Static Assets for the page itself.

## Publishing it

You need a Cloudflare account. There is no database to create by hand and no
config file to edit — the deploy resolves all of that itself.

### From a browser, including a phone

No terminal required. Two secrets, one button.

**1. Get a Cloudflare API token.** In the Cloudflare dashboard: **My Profile →
API Tokens → Create Token**, use the **Edit Cloudflare Workers** template, and
copy the token. It is shown once.

**2. Get your Account ID.** Cloudflare dashboard → **Workers & Pages**; the
account id is in the right-hand sidebar (on mobile, scroll past the main panel).

**3. Put both into GitHub.** In this repo: **Settings → Secrets and variables →
Actions → New repository secret**. Add them with exactly these names:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the id from step 2 |

**4. Run it.** Go to the **Actions** tab → **Deploy** → **Run workflow**.

It creates the D1 database if it does not exist, points `wrangler.jsonc` at it,
applies the migrations and deploys. Your `*.workers.dev` URL is printed at the
end of the **Deploy** step's log. Every later push to `main` redeploys
automatically.

### From a terminal

```bash
git clone <this repo>
cd togetherly
./setup.sh
```

Same steps, run locally: installs dependencies, opens a browser for the
Cloudflare login, creates the database, migrates, deploys. Re-run it any time —
every step checks whether it has already been done.

### Then

Open the URL, tap **Start a new pair**, and send the six-character code to your
partner. The code works exactly once — after they join it stops working, which
is the point.

### A custom domain (optional)

Add the route to `wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "togetherly.example.com", "custom_domain": true }]
```

The domain has to be on the same Cloudflare account. Cloudflare handles the
certificate.

## Working on it

```bash
npm run dev                # http://localhost:8788, local D1, no account needed
npm run db:migrate:local   # apply migrations to the local database
npm run db:migrate         # apply migrations to the real one
npm run deploy             # ship it
npm run tail               # live logs from production
```

`npm run dev` uses a local SQLite file under `.wrangler/`, so you can develop
offline and against throwaway data. Open the app in a normal window and an
incognito one to play both partners at once.

## Layout

```
public/index.html      the entire frontend — no build step, no dependencies
src/worker.js          the API, and the only thing that touches data
migrations/            D1 schema, applied in order by wrangler
wrangler.jsonc         bindings and routing
scripts/provision.mjs  creates the database and points wrangler.jsonc at it
setup.sh               first-run setup from a terminal
docs/architecture.md   how it works, and why it works this way
```

There is no bundler and no framework. `public/index.html` is served as written.

## Costs

Comfortably inside Cloudflare's free tier for two people: the free plan covers
100,000 Worker requests and 100,000 D1 row reads a day, and page loads are
served as static assets without invoking the Worker at all. Two people polling
every twenty seconds is a few thousand requests a day.

## Notes on privacy

Read `docs/architecture.md` for the detail, but the short version: your
partner's answers are withheld by the server, not hidden by the page. Until you
have both submitted, their check-in is never included in any response your
browser receives. Session tokens are stored only as hashes. There is no
analytics, no third-party script, and no outbound request to anywhere but your
own Worker.
