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

## Setting it up

You need a Cloudflare account. Nothing else — no database to provision, no
keys to copy between dashboards.

```bash
git clone <this repo>
cd togetherly
./setup.sh
```

`setup.sh` installs dependencies, opens a browser for the Cloudflare login,
creates the D1 database, writes its id into `wrangler.jsonc`, applies the
migrations and deploys. It prints your `*.workers.dev` URL at the end. Re-run
it any time; every step checks whether it has already been done.

Then commit the database id it wrote:

```bash
git commit -am "Add D1 database id"
```

Open the URL, tap **Start a new pair**, and send the six-character code to your
partner. The code works exactly once — after they join it stops working, which
is the point.

### Deploying on every push (optional)

`.github/workflows/deploy.yml` deploys `main` to Cloudflare. It needs two
repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right-hand sidebar |

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
setup.sh               first-run setup
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
