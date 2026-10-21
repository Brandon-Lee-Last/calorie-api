#!/usr/bin/env bash
# One-time setup of a Cloudflare environment: D1 database, R2 bucket. Run it yourself, signed in with
#   wrangler login        (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID exported)
# Usage: scripts/bootstrap-cloudflare.sh stage|production
set -euo pipefail
ENV_NAME="${1:?usage: bootstrap-cloudflare.sh stage|production}"
case "$ENV_NAME" in stage | production) ;; *) echo "environment must be stage or production" >&2; exit 1 ;; esac

DB="calorie-$ENV_NAME"
BUCKET="calorie-media-$ENV_NAME"

echo "Creating D1 database $DB ..."
npx wrangler d1 create "$DB" || echo "(already exists? continuing)"
echo
echo "Creating R2 bucket $BUCKET ..."
npx wrangler r2 bucket create "$BUCKET" || echo "(already exists? continuing)"
echo
echo "Database id (put this in the GitHub $ENV_NAME environment variable D1_DATABASE_ID):"
npx wrangler d1 info "$DB" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))'
