#!/usr/bin/env bash
# Creates the GitHub "stage" and "production" environments and fills in their secrets and variables, so the
# pipelines can deploy. Needs the GitHub CLI signed in as a repo admin (gh auth login).
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#   D1_DATABASE_ID=... API_HOST=api-stage.example.com \
#   scripts/setup-github-environments.sh stage
#
# JWT_SECRET, MEDIA_SIGNING_SECRET and ADMIN_API_KEY are generated here and never printed. Run it once per
# environment; re-running rotates them (which signs everyone out), so pass KEEP_SECRETS=1 to leave them alone.
set -euo pipefail
ENV_NAME="${1:?usage: setup-github-environments.sh stage|production}"
case "$ENV_NAME" in stage | production) ;; *) echo "environment must be stage or production" >&2; exit 1 ;; esac
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID D1_DATABASE_ID API_HOST; do
  [ -n "${!v:-}" ] || { echo "$v is required" >&2; exit 1; }
done

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Repository: $REPO, environment: $ENV_NAME"
gh api -X PUT "repos/$REPO/environments/$ENV_NAME" >/dev/null

gh secret set CLOUDFLARE_API_TOKEN --env "$ENV_NAME" --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --env "$ENV_NAME" --body "$CLOUDFLARE_ACCOUNT_ID"
gh variable set D1_DATABASE_ID --env "$ENV_NAME" --body "$D1_DATABASE_ID"
gh variable set API_HOST --env "$ENV_NAME" --body "$API_HOST"
gh variable set GOOGLE_CLIENT_IDS --env "$ENV_NAME" --body "${GOOGLE_CLIENT_IDS:-}"

if [ -z "${KEEP_SECRETS:-}" ]; then
  gh secret set JWT_SECRET --env "$ENV_NAME" --body "$(openssl rand -base64 48 | tr -d '\n')"
  gh secret set MEDIA_SIGNING_SECRET --env "$ENV_NAME" --body "$(openssl rand -base64 48 | tr -d '\n')"
  gh secret set ADMIN_API_KEY --env "$ENV_NAME" --body "$(openssl rand -base64 36 | tr -d '\n')"
  echo "Generated JWT_SECRET, MEDIA_SIGNING_SECRET and ADMIN_API_KEY (stored in GitHub only)."
fi

if [ "$ENV_NAME" = "production" ]; then
  echo
  echo "Now add required reviewers: GitHub > Settings > Environments > production > Required reviewers."
  echo "Without that, a tag push deploys to production with no approval."
fi
echo "Done. Test it: Actions > Deploy $ENV_NAME > Run workflow."
