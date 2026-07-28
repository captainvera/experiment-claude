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
CONFIG="wrangler.jsonc"
PLACEHOLDER="PASTE_DATABASE_ID_HERE"

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
if grep -q "$PLACEHOLDER" "$CONFIG"; then
  # Creating twice is an error, and that is fine: we only need it to exist.
  npx wrangler d1 create "$DB_NAME" >/dev/null 2>&1 || note "database already exists, reusing it"

  DB_ID="$(npx wrangler d1 list --json 2>/dev/null | node -e "
    let raw='';
    process.stdin.on('data', d => raw += d);
    process.stdin.on('end', () => {
      const list = JSON.parse(raw);
      const db = list.find(d => d.name === process.argv[1]);
      if (!db) { console.error('Could not find the database'); process.exit(1); }
      process.stdout.write(db.uuid || db.database_id || db.id);
    });
  " "$DB_NAME")"

  if [ -z "$DB_ID" ]; then
    echo "Could not work out the database id. Run 'npx wrangler d1 list' and paste it into $CONFIG by hand." >&2
    exit 1
  fi

  # BSD and GNU sed disagree about -i, so write through a temp file instead.
  sed "s/$PLACEHOLDER/$DB_ID/" "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  note "database id $DB_ID written to $CONFIG"
else
  note "already configured"
fi

# --- 4. schema -------------------------------------------------------------
say "4/5  Applying migrations"
npx wrangler d1 migrations apply "$DB_NAME" --remote

# --- 5. deploy -------------------------------------------------------------
say "5/5  Deploying"
npx wrangler deploy

say "Done."
note "Commit the database id in $CONFIG so future deploys use the same database."
note "Open the workers.dev URL above, tap 'Start a new pair', and send the code to your partner."
