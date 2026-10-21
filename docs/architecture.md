# Calorie API: architecture and plan

Backend for the calorie app. Cloudflare Workers + Hono + D1, with R2 for media and Workers AI for text features.
**The photo scanner is not here.** The custom model (`nutrition_v1.tflite`) runs on the phone: Workers cannot run
it, and on-device is what keeps scans private and offline. The backend stores what the user chooses to keep.

## Principles

- **Offline-first client, server as the sync hub.** Every record has a client-generated id, so a phone can create
  data offline and upload it later without duplicates. Accounts are optional to start: a device account
  works immediately and can be linked to Google later.
- **One folder per feature**, same file names everywhere (`*.routes.ts`, `*.service.ts`, `*.repo.ts`, `*.schemas.ts`).
  Routes parse and respond, services hold rules, repos hold SQL. Nothing else touches D1.
- **Zod schemas are the contract.** `@hono/zod-openapi` turns them into `/v1/openapi.json`, which the app can
  generate its client from.
- **Everything external sits behind an interface** (billing, Google sign-in, AI, food lookup, clock, rate limiter)
  so tests inject fakes and nothing real is needed to run the suite.
- **Honest limits.** On-device scanning cannot be enforced server-side. Quotas on scans are advisory (the app
  reads them from `/v1/entitlements`); quotas on server work (AI, sync history, premium content) are enforced.

## Layout

```
src/
  index.ts            Worker entry: fetch + scheduled
  app.ts              createApp(deps): middleware + route mounting
  env.ts              Bindings type + validated config
  core/               errors, ids, time, crypto, pagination, logger, http helpers
  db/                 thin typed D1 helpers
  middleware/         request-id, access log, errors, security headers, auth, rate limit, entitlements
  lib/                pure domain maths (BMR/TDEE, macros, units, dates)
  modules/
    health/  auth/  users/  foods/  diary/  body/  scans/  sync/
    subscriptions/  workouts/  media/  ai/  insights/  account/  admin/
migrations/           numbered D1 migrations
test/                 shared helpers, fakes, end-to-end tests
scripts/              bootstrap + deploy helpers
.github/workflows/    ci, deploy-stage, deploy-production
docs/
```

## Environments and pipeline

|         | local          | stage                        | production                           |
| ------- | -------------- | ---------------------------- | ------------------------------------ |
| Worker  | `wrangler dev` | `calorie-api-stage`          | `calorie-api-production`             |
| D1      | local sqlite   | `calorie-stage`              | `calorie-production`                 |
| R2      | local          | `calorie-media-stage`        | `calorie-media-production`           |
| Billing | mock           | mock (simulate endpoints on) | Google Play (simulate endpoints off) |
| Deploy  | manual         | every push to `main`         | manual run, approval required        |

- **Secrets** live in GitHub _environment_ secrets (`stage`, `production`), never in the repo. The deploy job
  pushes them to the Worker with `wrangler secret bulk`. **Variables** (non-secret: D1 ids, hostnames, model names)
  live in GitHub environment variables and are substituted into `wrangler.jsonc` at deploy time.
- `ci.yml` (every PR): typecheck, format check, tests with coverage thresholds, `wrangler deploy --dry-run`.
- `deploy-stage.yml` (push to `main`): CI, apply D1 migrations, sync secrets, deploy, smoke-test `/v1/health`.
- `deploy-production.yml` (manual, environment protection): same steps with reviewers in the way. Migrations
  are forward-only and written to be backwards compatible with the previous release (expand, then contract).

## Data (D1)

Time is stored as integer milliseconds (UTC). Each logged item also carries a `local_date` (`YYYY-MM-DD`) chosen
by the client in the user's timezone, so "today" never depends on server clock tricks. Soft delete (`deleted_at`)
on anything that syncs, so deletions reach other devices; a nightly cron purges old tombstones.

| Table                                                                     | Purpose                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `users`, `user_profiles`                                                  | account, body stats, goals                                                                                     |
| `identities`                                                              | `(provider, subject)` -> user (`device`, `google`)                                                             |
| `refresh_tokens`                                                          | hashed, rotated on use, reuse of an old token kills the whole family                                           |
| `foods`                                                                   | custom foods and cached external foods (Open Food Facts by barcode)                                            |
| `diary_entries`                                                           | meals logged (scan, manual, food, AI text, quick add)                                                          |
| `scan_events`                                                             | what the on-device model predicted vs what the user kept (retraining signal), consent-gated image contribution |
| `weight_logs`, `water_logs`                                               | body tracking                                                                                                  |
| `subscriptions`, `subscription_events`                                    | entitlement state and an idempotent event ledger                                                               |
| `usage_counters`                                                          | per-user, per-day counters for quotas                                                                          |
| `media`, `exercises`, `programs`, `program_workouts`, `workout_exercises` | workout library (free and paid)                                                                                |
| `program_enrollments`, `workout_sessions`, `set_logs`                     | a user's progress through programs                                                                             |

D1 notes for scale: one database tops out at 10 GB and writes are serialised, so queries are indexed on
`(user_id, ...)`, lists are cursor-paginated, writes are batched, and the repos are the only code that knows the
database layout. If one database stops being enough, users can be sharded across several D1 databases
behind the repo layer without touching routes or services.

## Auth

- Access token: short-lived JWT (15 min, HS256, `jose`). Refresh token: 256-bit random, only its SHA-256 is stored,
  rotated on every refresh, with family-wide revocation if an already-used token comes back.
- Sign-in methods: **device** (anonymous account created on first launch, protected by a refresh token),
  **Google** (ID token verified against Google's keys; client ids from config). Linking Google to a device account
  keeps the data. Email/OTP can be added behind the same `IdentityProvider` interface.

## Subscriptions (mocked until the Play account exists)

`BillingProvider` interface with a **mock** provider (tokens such as `mock_pro_monthly_active`) and a
**Google Play** provider that is a stub until there is a developer account and service account. The
entitlement rules (`active`, `grace`, `on hold`, `canceled but paid through`, `expired`, `refunded`) are a pure
function, tested exhaustively, so switching providers changes nothing else. Stage exposes
`/v1/subscription/simulate/*` so the app team can drive every state; production does not.
To go live later: Play Developer API service account, Real-time Developer Notifications (Pub/Sub push, verified),
and the app passing `obfuscatedExternalAccountId` = the user id so purchases bind to accounts.

## Plans

|                                                   | Free          | Pro                     |
| ------------------------------------------------- | ------------- | ----------------------- |
| Diary, custom foods, barcode lookup, weight/water | yes           | yes                     |
| Sync across devices                               | yes           | yes                     |
| On-device photo scans (advisory)                  | N per day     | unlimited               |
| AI text logging ("2 eggs and toast")              | 5 per day     | 100 per day             |
| Weekly insights                                   | summary       | full + AI narrative     |
| Workout programs                                  | free programs | all programs and videos |

Numbers live in `src/config/plans.ts` in one place.

## Workouts and media

Content model: **programs** (weeks x days) -> **workouts** -> **exercises** (with sets/reps/rest), each item tagged
`free` or `pro`, plus **media** rows that point at a file. Users enroll in a program, log sessions and sets.

Media storage:

- **R2** (private bucket) for images, thumbnails, PDFs and short MP4 clips: no egress fees, simple.
  The Worker checks the entitlement and returns a short-lived HMAC-signed URL; the media route streams from R2
  with `Range` support so video seeks work. Free media gets long cache headers so Cloudflare's CDN serves it.
- **Cloudflare Stream** for long-form video later (adaptive bitrate, signed playback tokens). The `media.provider`
  column (`r2` | `stream` | `external`) means moving a video does not change the API.
- **External** links (a creator's YouTube/Vimeo embed) are supported for content shared with permission.
- Content authoring: an admin API (static admin key for now, Cloudflare Access later) and a JSON importer.

**Rights:** only use video and images you own, have licensed, or that are openly licensed. Open sources worth
checking the licence of before use: the free-exercise-db dataset (exercise data and photos) and wger. Do not copy
another site's programs or videos.

## Workers AI

Behind an `AiClient` interface (fake in tests): parse free-text meals into items with nutrition estimates (always
flagged as estimates for the user to confirm), and a weekly insight narrative written from computed numbers (the
numbers are calculated in code, the model only words them). Model ids are config, not code. Metered per user per day.

## Cross-cutting

Request ids on every response and log line, structured JSON logs with PII redaction, uniform error body
`{ error: { code, message, details?, requestId } }`, security headers, body size limits, per-IP burst limiting and
per-user quotas, idempotent writes, constant-time secret comparison, POPIA/GDPR export and delete
(`GET /v1/account/export`, `DELETE /v1/account`, purge cron).

## Status

Everything in the phase plan is built and tested locally, plus the hardening round: foundation and pipeline, auth (anonymous, Google,
email codes), profile, foods and a shared catalogue with an importer, diary, weight, water, recipes, exercise and steps, body
measurements, progress photos, scans and sync (nine record types), subscriptions (mock store, and a Google Play provider with
real-time notifications tested against fakes), workouts, media (R2, external, signed Cloudflare Stream), admin with an audit log,
AI text parsing, insights, push reminders, training-data export, account export and deletion, nightly housekeeping, a public
`/config` with maintenance mode, minimum app version and feature kill switches, shared (D1) rate limits, per-account and global AI
limits, optional Play Integrity, JWT key rotation, error alerts, and a route fuzzer, injection tests and a secret scan in CI.

What remains needs accounts or decisions that only the owner can supply: the first deploy to Cloudflare, a Play developer account
(and then a licence-tester run of billing), Firebase, a mail domain, Google OAuth client ids, legal text, and licensed content.
See [operations.md](operations.md) for the setup steps and the plain list of limits.

Decisions worth remembering:

- **Sync** uses a per-user revision counter, not timestamps, so a phone with a wrong clock cannot make records appear or vanish.
- **Deletes** from a direct `DELETE` always apply; deletes that arrive through sync lose to a newer edit like any other change.
- **Deleted accounts** are rejected on the next request, not when their token expires.
- **The mock store** can never grant Pro in production.
- **Stores are never believed by default.** A Play notification only says which purchase changed; the state is always re-read from
  the Play API, and a purchase only counts for the account named in it.
- **At-least-once is made safe**: reminders are claimed before they are sent, store notifications are recorded once, imports and
  writes are idempotent.
- **AI** only ever sees the person's typed meal text (as data, with validated output) or already-computed numbers.
