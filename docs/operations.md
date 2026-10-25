# Operations: setting up, deploying, running

## One-time setup

### Addresses

The API lives under the `lightarch.io` zone on Cloudflare, one prefix per app, so other apps can sit beside it:

| Environment | Address                                | Set in                                                  |
| ----------- | -------------------------------------- | ------------------------------------------------------- |
| stage       | `https://pango-api-stage.lightarch.io` | `deploy-stage.yml`, `content.yml`, `food-catalogue.yml` |
| production  | `https://pango-api.lightarch.io`       | `deploy-production.yml`                                 |

Keep them one level under `lightarch.io` (not `api.pango.lightarch.io`): Cloudflare's free certificate covers
`*.lightarch.io` only. The deploy makes the DNS record and certificate itself (a Worker custom domain). The Worker's
`workers.dev` address stays on as well, so app builds made before the domain still reach it.

### Quick start: stage in the browser

Everything below happens in the Cloudflare and GitHub websites; nothing to install.

1. **Cloudflare** (dash.cloudflare.com):
   - Delete any API token that was ever pasted into a chat (My Profile > API Tokens).
   - R2: turn it on (it asks for a card; the free allowance is plenty for testing).
   - Recommended: the Workers Paid plan (US$5 a month). The free plan caps calls per request, and a big sync can hit it.
   - Create an API token (My Profile > API Tokens > Create Token > Custom): Account > Workers Scripts: Edit, D1: Edit,
     Workers R2 Storage: Edit, Account Settings: Read; Zone (`lightarch.io` only) > Zone: Read, Workers Routes: Edit,
     DNS: Edit. Copy it straight into GitHub (next step), nowhere else.
2. **GitHub** (this repo > Settings > Environments > New environment `stage`):
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard, right-hand side of the account home),
     and `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, `ADMIN_API_KEY`: three different long random strings, for example from
     `python -c "import secrets; print(secrets.token_urlsafe(48))"`, run once for each.
   - Variable: `OFF_USER_AGENT` = `Pango/1.0 (your contact email)`.
3. **Deploy**: push to `main` (or Actions > Deploy stage > Run workflow). The first deploy creates the D1 database and
   the R2 bucket itself and prints the database id; `D1_DATABASE_ID` only needs setting if you want to pin it.
4. **Food list**: Actions > Food catalogue > Run workflow, tick "import".

The longer route below is the same thing done from a terminal.

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
Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit, Account Settings: Read; and for the zone: Zone: Read, Workers
Routes: Edit, DNS: Edit.
Use a **separate token per environment** if you can, and never paste one into chat or a file. (A token was shared in the chat
while this was built: rotate it.)

### 2. GitHub

Create the repository, push this code, then create the two environments and fill their secrets and variables
(needs `gh auth login` as a repo admin):

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=<from step 1> \
  scripts/setup-github-environments.sh stage
# repeat for production with its own values
```

That script generates `JWT_SECRET`, `MEDIA_SIGNING_SECRET` and `ADMIN_API_KEY` itself and stores them only in GitHub.
Afterwards open **Settings > Environments > production** and add **Required reviewers**; without that, pushing a version tag
deploys to production with no approval.

| GitHub environment value                              | Kind     | What it is                                                                      |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`       | secret   | how the pipeline signs in                                                       |
| `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, `ADMIN_API_KEY` | secret   | generated; pushed to the Worker as secrets                                      |
| `GOOGLE_PLAY_*`                                       | secret   | later, for real billing                                                         |
| `D1_DATABASE_ID`                                      | variable | substituted into `wrangler.jsonc` at deploy time (optional: else found or made) |
| `GOOGLE_CLIENT_IDS`                                   | variable | comma separated Google OAuth client ids (empty until Google sign-in is set up)  |
| `OFF_USER_AGENT`                                      | variable | e.g. `Pango/1.0 (you@example.com)`, which Open Food Facts asks callers to send  |

### 3. First deploy

Push to `main`. `deploy-stage` runs CI, applies migrations, deploys, pushes secrets, and smoke-tests `/v1/health` and
`/v1/health/ready`. Then load some content and look around:

```bash
API_BASE=https://pango-api-stage.lightarch.io ADMIN_API_KEY=<the stage key> npm run import:content -- content/sample --publish
API_BASE=https://pango-api-stage.lightarch.io ADMIN_API_KEY=<the stage key> npm run import:content -- content/meal-plans --prune
```

The Publish content workflow does both whenever `content/` changes on `main`, after checking the meal plans' ingredient figures against
USDA ([meal-plans.md](meal-plans.md)).

Open `https://pango-api-stage.lightarch.io/v1/openapi.json`. Things to check on stage, because they have only been tested against fakes:

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
- **Rotating secrets**: to change `JWT_SECRET` without any failed request, copy the current value into `JWT_SECRET_PREVIOUS`, put the new value in
  `JWT_SECRET`, deploy, and remove `JWT_SECRET_PREVIOUS` fifteen minutes later (new tokens are signed with the new key; ones signed with the old key
  still verify until they expire). Changing it with no previous value is also safe: tokens already out fail once, apps refresh and carry on, and
  nobody is signed out, because refresh tokens live in the database. Pending email codes and rate-limit counts reset when it changes. Changing `MEDIA_SIGNING_SECRET` breaks only media links already handed
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

## Hardening the admin API

The admin API (`/v1/admin/*`) can wipe or rewrite content, so it has layers; use as many as you can:

1. **The admin key** (`ADMIN_API_KEY`): required always. Ten wrong keys from one address lock that address out for 15 minutes.
2. **An address allowlist**: set the variable `ADMIN_ALLOWED_IPS` to your office or home IPs, comma separated, ranges allowed
   (`203.0.113.0/24, 198.51.100.7`). Requests from anywhere else get 403 before the key is even looked at.
3. **Cloudflare Access** (Zero Trust, free for a few users): create an Access application for `https://<api host>/v1/admin/*`
   with a policy that lets only you in, then set `CF_ACCESS_TEAM_DOMAIN` (`yourteam.cloudflareaccess.com`) and `CF_ACCESS_AUD`
   (the application's Audience tag). The Worker then also checks the signed login on every admin call, so a leaked key alone is useless.
4. **The audit log**: every admin call, including refused ones, is recorded with who made it (the Access email, or `api-key`).
   Read it with `GET /v1/admin/audit`. Kept 180 days.

## Alerts, maintenance and kill switches

- **Error alerts**: set `ALERT_WEBHOOK_URL` (a secret) to a Slack, Discord or Mattermost incoming-webhook URL. You get a message for
  an unexpected server error, a failed nightly or reminder job, and when the daily AI budget is used up. The same problem is sent at most
  once per five minutes and never more than 30 an hour, and a message carries no personal data.
- **Maintenance mode**: `PUT /v1/admin/settings` with `{"maintenance":{"enabled":true,"message":"Back at 9"}}`. Within seconds every
  call except health, `/config`, `/openapi.json` and admin answers 503 `maintenance` with `Retry-After`. Turn it off the same way.
- **Force an update**: `{"minAppVersion":"1.4.0"}`. Apps that send `x-app-version` older than that get 426 `upgrade_required`; set
  `STORE_URL` so the response says where to update. `latestAppVersion` only makes `GET /config` report `update: "available"`.
- **Kill switches**: `{"disabledFeatures":["aiText"]}` stops AI meal parsing at once (503 `feature_disabled`); `emailSignIn` stops email codes.
  `workouts` and `scanContributions` are only reported in `GET /config` for the app to hide.
- `AI_DAILY_BUDGET` (variable, default 20000) is the most AI calls the whole service makes in a day. Accounts with no sign-in method get 2
  a day instead of 5; one address gets 60 a day across all its accounts.

## Abuse and account creation

Creating a throwaway account is the cheapest way to dodge free limits. The API counts in D1, so limits hold across all Worker instances:
10 new accounts an hour and 30 a day per address (stored as a keyed hash, never the address). For a stronger gate turn on **Play Integrity**:
set the variable `REQUIRE_INTEGRITY=true` once the app is on Play and the service account may call the Play Integrity API; the app then
asks `GET /auth/challenge`, passes it to Play Integrity as the nonce, and sends `x-integrity-token` and `x-integrity-challenge` with
`POST /auth/anonymous`. Outside production a fixed token (`mock-integrity-ok`) stands in so the flow can be built before Play exists.

## Email sign-in

Account recovery without Google. Set `RESEND_API_KEY` (secret) and `EMAIL_FROM` (variable, for example `Calories <login@yourdomain.com>`
on a domain verified in Resend). Until then, outside production the code is written to the log instead of sent, and production refuses
(`501`). Codes are six digits, valid for ten minutes, once, with five guesses; the same email address is recognised as the same person
whether they came in through Google or email.

## Push reminders

Set `FCM_PROJECT_ID` (variable) and `FCM_SERVICE_ACCOUNT_JSON` (secret: a Firebase service account key allowed to send messages). A job
runs every five minutes (second cron entry in `wrangler.jsonc`), sends what is due in each person's own timezone, and sends each
reminder once even if two runs overlap. Reminders more than 90 minutes late are skipped. Without Firebase configured, production does
nothing and leaves reminders untouched so they go out as soon as it is set up. `POST /v1/admin/reminders/run` runs the job by hand.
One run handles 60 reminders; beyond roughly ten thousand active users, move sending to Cloudflare Queues.

## Food catalogue and training data

- **Foods**: `node scripts/import-foods.mjs <file> --format usda|csv|json` (see the header of the script). USDA FoodData Central (CC0)
  downloads convert directly; nothing is estimated, foods missing an energy or macro figure are skipped and counted. For South African
  foods use figures from SAFOODS (SAMRC) or lab/weighed data and put the reference in `externalId`. `--dry-run` checks without writing.
- **Food search data**: the **Food catalogue** workflow (Actions, run by hand) builds what search finds: USDA generic foods (Foundation
  and SR Legacy, public domain) and Open Food Facts products sold in South Africa (`--format off`, streamed from the full export, same
  reading as the barcode lookup but stricter: all macros stated, energy that agrees with them). Tick "import" to load it into stage;
  otherwise download the `food-catalogue` artifact and run `node scripts/import-foods.mjs off.json --format json` (and `usda.json`)
  with `API_BASE` and `ADMIN_API_KEY` set. Re-run it every month or two for new products. Open Food Facts data is ODbL: the app credits
  it, and the Open Food Facts part of the catalogue must be shared under the ODbL if someone asks. The app also searches Open Food
  Facts directly from the phone when someone taps "Search Open Food Facts" (their limit is 10 searches a minute per user), and a
  product picked there is fetched through the barcode lookup, which adds it to the catalogue for everyone.
- **Training data**: `node scripts/export-training-data.mjs --out data/app_contrib` downloads photos people agreed to contribute, with
  what they kept, as an `--extra-data` folder for the model repo (corrected photos at low weight; photos the person simply accepted are
  left out because the label would be the model's own guess). Photos are stripped of GPS and device details on upload. Keep the folder
  private, and re-export from scratch now and then so people who withdrew consent drop out.

## Streaming video (Cloudflare Stream)

Upload videos to Stream with "require signed URLs" on, create a signing key (`POST /accounts/{id}/stream/keys`), and set
`STREAM_CUSTOMER_CODE` and `STREAM_SIGNING_KEY_ID` (variables) and `STREAM_SIGNING_KEY_PEM` (secret, the `pem` the key call returns).
Create the media entry with `provider: "stream"` and `location` = the Stream video id. The app gets a one-hour HLS playlist link.

## Secrets and variables, in one place

Secrets (GitHub environment **secrets**): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, `ADMIN_API_KEY`
(required), and when needed `JWT_SECRET_PREVIOUS`, `RESEND_API_KEY`, `FCM_SERVICE_ACCOUNT_JSON`, `STREAM_SIGNING_KEY_PEM`,
`ALERT_WEBHOOK_URL`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_RTDN_AUDIENCE`.

Variables (GitHub environment **variables**): `D1_DATABASE_ID` (the first deploy finds or makes the database when unset); `GOOGLE_CLIENT_IDS`, `BILLING_PROVIDER` (`mock` or
`google_play`), `REQUIRE_INTEGRITY`, `AI_DAILY_BUDGET`, `EMAIL_FROM`, `FCM_PROJECT_ID`, `STREAM_CUSTOMER_CODE`, `STREAM_SIGNING_KEY_ID`,
`MIN_APP_VERSION`, `LATEST_APP_VERSION`, `STORE_URL`, `PRIVACY_URL`, `TERMS_URL`, `SUPPORT_EMAIL`, `ADMIN_ALLOWED_IPS`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT`, `MAINTENANCE_MODE`, `MAINTENANCE_MESSAGE`, `OFF_USER_AGENT`.

Unset ones are simply not sent. Taking one away later does not delete it from the Worker: run `npx wrangler secret delete NAME --env <env>`.
The live switches in `PUT /v1/admin/settings` (maintenance, versions, features) override the matching variables without a deploy.

## Going live with real subscriptions (Google Play)

The code is written and tested against a fake Play API, but it has never spoken to the real one: that needs accounts that do not exist yet.
When they do:

Not done, because it needs accounts that do not exist yet. When they do:

1. Create the Play developer account, the app, and the subscription products `pro_monthly` and `pro_yearly`.
2. Create a service account with access to the Play Developer API and put its JSON in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
3. Set `GOOGLE_PLAY_PACKAGE_NAME` and make the app pass the user id as the purchase's obfuscated account id (a purchase only counts for
   the account named in it).
4. Real-time notifications: create a Pub/Sub topic for the app, give `google-play-developer-notifications@system.gserviceaccount.com`
   publish rights, create a **push** subscription to `https://<api host>/v1/webhooks/google-play` with authentication on (a service
   account of yours, audience = that URL). Set `GOOGLE_PLAY_RTDN_AUDIENCE` to the audience and `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT` to its email.
5. Set `BILLING_PROVIDER` to `google_play` for production.
   Until then production answers `501 not_configured` to purchases: the mock cannot grant Pro there.
6. **Before launch, test with a licence tester account**: a purchase, a renewal, a cancellation, a payment failure (grace period) and a
   refund, and watch the logs. Check especially how a free trial appears, what the expiry time is during a grace period, and that the
   purchase is acknowledged. The nightly job re-reads shaky subscriptions, so a missed notification heals itself.

## Known limits, stated plainly

- **On-device scans cannot be metered securely.** The server counts them and reports the count; the app has to enforce the daily limit.
- **Access tokens live up to 15 minutes after logout.** Deleted accounts are rejected immediately; logging out ends refresh, not
  already-issued access tokens.
- **D1 limits**: 10 GB per database and serialised writes. Fine for a long while; the repo layer is where sharding would go.
- **Search** is substring matching, adequate for thousands of foods. Use FTS5 if the catalogue grows to hundreds of thousands.
- **Workers AI and Open Food Facts** are untested against the live services.
- **Google Play, Firebase, Resend, Play Integrity and Cloudflare Stream** are written from their documentation and tested against fakes;
  none has run against the live service.
- **Content rights**: only upload video and text you own or are licensed to use. Credit goes in each exercise's `source` and `licence`.
- **Privacy**: contributed scan photos are stored only with consent and removed with the account. Check POPIA obligations (privacy
  notice, consent wording, an information officer) with someone qualified; this is not legal advice.
