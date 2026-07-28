#!/usr/bin/env bash
#
# One-shot setup for Togetherly on Cloudflare.
#
#   ./setup.sh
#
# Logs you in, creates the D1 database, wires its id into wrangler.jsonc,
# runs the migrations and deploys. Safe to re-run: every step checks whether
# it has already been done.

set -euo pipefail

DB_NAME="togetherly"

cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# --- 1. dependencies -------------------------------------------------------
say "1/5  Installing dependencies"
if [ -d node_modules ]; then
  note "already installed"
else
  npm install --no-audit --no-fund
fi

# --- 2. Cloudflare login ---------------------------------------------------
say "2/5  Signing in to Cloudflare"
if npx wrangler whoami >/dev/null 2>&1; then
  note "already signed in as: $(npx wrangler whoami 2>/dev/null | grep -oE '[[:alnum:]._%+-]+@[[:alnum:].-]+' | head -1 || echo 'your account')"
else
  note "a browser window will open — approve the Wrangler login"
  npx wrangler login
fi

# --- 3. D1 database --------------------------------------------------------
say "3/5  Creating the database"
node scripts/provision.mjs

# --- 4. schema -------------------------------------------------------------
say "4/5  Applying migrations"
npx wrangler d1 migrations apply "$DB_NAME" --remote

# --- 5. deploy -------------------------------------------------------------
say "5/5  Deploying"
npx wrangler deploy

say "Done."
note "Open the workers.dev URL above, tap 'Start a new pair', and send the code to your partner."
