# Operations: setting up, deploying, running

## One-time setup

### 1. Cloudflare

You need a Cloudflare account with a domain (zone) on it for the API hostnames, R2 turned on (Dashboard > R2), and
Workers AI available. Use the **Workers Paid plan** for anything real: the free plan allows only 50 outbound calls per
request (D1 queries count) and a sync push can use more.

Sign in with `npx wrangler login`, or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then for each environment:

```bash
scripts/bootstrap-cloudflare.sh stage         # creates D1 "calorie-stage" and R2 "calorie-media-stage", prints the D1 id
scripts/bootstrap-cloudflare.sh production
```

**API token for the pipeline** (Dashboard > My Profile > API Tokens > Create). Give it, for this account:
Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit, Account Settings: Read; and for the zone: Workers Routes: Edit.
Use a **separate token per environment** if you can, and never paste one into chat or a file. (A token was shared in the chat
while this was built: rotate it.)

### 2. GitHub

Create the repository, push this code, then create the two environments and fill their secrets and variables
(needs `gh auth login` as a repo admin):

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=<from step 1> API_HOST=api-stage.example.com \
  scripts/setup-github-environments.sh stage
# repeat for production with its own values, API_HOST=api.example.com
```

That script generates `JWT_SECRET`, `MEDIA_SIGNING_SECRET` and `ADMIN_API_KEY` itself and stores them only in GitHub.
Afterwards open **Settings > Environments > production** and add **Required reviewers**; without that, pushing a version tag
deploys to production with no approval.

| GitHub environment value                              | Kind     | What it is                                                                          |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`       | secret   | how the pipeline signs in                                                           |
| `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, `ADMIN_API_KEY` | secret   | generated; pushed to the Worker as secrets                                          |
| `GOOGLE_PLAY_*`                                       | secret   | later, for real billing                                                             |
| `D1_DATABASE_ID`, `API_HOST`                          | variable | substituted into `wrangler.jsonc` at deploy time                                    |
| `GOOGLE_CLIENT_IDS`                                   | variable | comma separated Google OAuth client ids (empty until Google sign-in is set up)      |
| `OFF_USER_AGENT`                                      | variable | e.g. `CalorieApp/1.0 (you@example.com)`, which Open Food Facts asks callers to send |

### 3. First deploy

Push to `main`. `deploy-stage` runs CI, applies migrations, deploys, pushes secrets, and smoke-tests `/v1/health` and
`/v1/health/ready`. Then load some content and look around:

```bash
API_BASE=https://api-stage.example.com ADMIN_API_KEY=<the stage key> npm run import:content -- content/sample --publish
```

Open `https://api-stage.example.com/v1/openapi.json`. Things to check on stage, because they have only been tested against fakes:

1. `POST /v1/ai/parse-meal` returns sensible items (Workers AI and the model id in `AI_TEXT_MODEL`).
2. `GET /v1/foods/barcode/<a real barcode>` returns a product (Open Food Facts).
3. Upload a video with `PUT /v1/admin/media/<key>/upload` and play it through `POST /v1/media/<id>/access` with seeking.
4. The nightly cron fires (Dashboard > Workers > Triggers) or run `POST /v1/admin/maintenance/run`.

### 4. Production

Push a tag (`git tag v0.1.0 && git push --tags`) or run **Deploy production** by hand. Someone approves, then it migrates, deploys
and smoke-tests the same way.

## Everyday

- **Migrations** are numbered SQL files, applied before each deploy, forward-only. Write each one so the _previous_ version of
  the code still works with it (add columns and tables first; remove old ones in a later release).
- **Rollback**: `npx wrangler rollback --env production` returns the code. The database does not roll back with it: that is why
  migrations stay compatible. D1 **Time Travel** can restore the database to any minute in the last 30 days:
  `npx wrangler d1 time-travel restore calorie-production --timestamp=<iso time>`.
- **Logs**: Workers Logs are on (Dashboard > Workers > Logs). Every request has one structured line with a request id, which is
  also returned in the `x-request-id` header and the error body. Passwords, tokens and emails are redacted.
- **Rotating secrets**: changing `JWT_SECRET` invalidates the access tokens already out (at most 15 minutes old); apps refresh and carry on, and
  nobody is signed out, because refresh tokens live in the database. Changing `MEDIA_SIGNING_SECRET` breaks only media links already handed
  out. Changing `ADMIN_API_KEY` locks out the importer until its copy is updated. To rotate through GitHub, re-run
  `scripts/setup-github-environments.sh` and deploy.

## Protecting the API at the edge

The in-app rate limiter is per instance, a brake and not a wall. Add Cloudflare **WAF rate limiting rules** (Security > WAF)
on each hostname, for example:

| Path                              | Suggested limit                                               |
| --------------------------------- | ------------------------------------------------------------- |
| `/v1/auth/*`                      | 30 requests per minute per IP                                 |
| `/v1/ai/*`, `/v1/foods/barcode/*` | 60 per minute per IP                                          |
| `/v1/admin/*`                     | 30 per minute per IP, and consider Cloudflare Access in front |
| everything else under `/v1/`      | 600 per minute per IP                                         |

Mobile carriers often put many people behind one IP, so keep these generous.

## Going live with real subscriptions (Google Play)

Not done, because it needs accounts that do not exist yet. When they do:

1. Create the Play developer account, the app, and the subscription products `pro_monthly` and `pro_yearly`.
2. Create a service account with access to the Play Developer API and put its JSON in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Implement `GooglePlayBillingProvider` (the comments in `src/modules/subscriptions/billing/google-play.ts` list exactly what),
   the real-time notification endpoint, and acknowledge purchases within three days.
4. Set `BILLING_PROVIDER` to `google_play` for production.
   Until then production answers `501 not_configured` to purchases: the mock cannot grant Pro there.

## Known limits, stated plainly

- **On-device scans cannot be metered securely.** The server counts them and reports the count; the app has to enforce the daily limit.
- **Access tokens live up to 15 minutes after logout.** Deleted accounts are rejected immediately; logging out ends refresh, not
  already-issued access tokens.
- **D1 limits**: 10 GB per database and serialised writes. Fine for a long while; the repo layer is where sharding would go.
- **Search** is substring matching, adequate for thousands of foods. Use FTS5 if the catalogue grows to hundreds of thousands.
- **Workers AI and Open Food Facts** are untested against the live services.
- **Cloudflare Stream** playback is not implemented (R2 and external links are).
- **Content rights**: only upload video and text you own or are licensed to use. Credit goes in each exercise's `source` and `licence`.
- **Privacy**: contributed scan photos are stored only with consent and removed with the account. Check POPIA obligations (privacy
  notice, consent wording, an information officer) with someone qualified; this is not legal advice.
