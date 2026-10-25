# Calorie API

The backend for the calorie app: accounts, sync, food database, subscriptions, workouts and media, AI text logging,
and insights. **Hono on Cloudflare Workers**, **D1** for data, **R2** for files, **Workers AI** for text features.

The photo scanner is not here. The custom model runs on the phone (see the `local-calorie-ai-model` and `calorie-app`
repos); this API stores what people choose to keep and learns from how often they correct the model.

```
npm install
npm test                 # 643 tests, in the real Workers runtime against a real D1
npm run test:scripts     # tests for the deploy scripts (plain Node)
npm run dev              # local server (copy .dev.vars.example to .dev.vars first)
npm run scan:secrets     # looks for committed tokens and keys
npm run check            # typecheck + formatting + secret scan + all tests
```

| Read this                                    | For                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | how it is built and why                                                 |
| [docs/api-guide.md](docs/api-guide.md)       | for the app team: auth, offline sync, subscriptions, workouts           |
| [docs/operations.md](docs/operations.md)     | setting up Cloudflare and GitHub, deploying, rollback, what is not done |
| `GET /v1/openapi.json`                       | the full API contract (generate the app's client from it)               |

## What is built

| Area          | Endpoints                                                           | Notes                                                              |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Auth          | anonymous, Google, email code sign-in; linking; refresh; logout     | rotating single-use refresh tokens; Play Integrity gate (opt-in)   |
| Me            | profile, body stats, calorie and macro goals                        | Mifflin-St Jeor recommendation with a safety floor                 |
| Diary         | entries, day summaries, recent foods, meal photos (R2)              | client-made ids, idempotent, later edit wins                       |
| Body          | weight, water                                                       | weight keeps the profile and goals in step                         |
| Foods         | custom foods, accent-insensitive search, barcode lookup             | Open Food Facts on demand, cached in a shared catalogue            |
| Scans         | what the on-device model said vs what the person kept               | consent-gated photo contribution; admin accuracy report            |
| Sync          | `pull?since=` and `push` over all synced records                    | per-user revision counter, no clock dependence                     |
| Subscriptions | entitlements, verify, restore, simulate (stage), Play notifications | mock store; Google Play provider tested against a fake only        |
| Workouts      | exercise library, free and Pro programs, enrolment, session logging | per-workout free samples inside Pro programs                       |
| Meal plans    | diet styles and the meals plans are built from                      | free and Pro styles; figures from USDA, checked on every change    |
| Media         | signed expiring links, Range and ETag, Pro gating                   | R2; external links; Cloudflare Stream signed playback              |
| AI            | text meal parsing                                                   | Workers AI; estimates only; metered; failed calls not charged      |
| Insights      | overview, weekly summary                                            | Pro adds depth and an AI-written summary built from numbers only   |
| Account       | data export, permanent delete                                       | removes every row and file; old tokens die at once                 |
| Admin         | media, exercises, programs, foods, settings, audit, accuracy        | key + optional IP allowlist + Cloudflare Access; every call logged |
| Recipes       | recipes with ingredients, per-serving figures                       | synced; free accounts keep a limited number                        |
| Activity      | exercise and daily steps                                            | synced; calories estimated from MET and weight, marked as such     |
| Measurements  | waist, hips, chest, body fat and more                               | synced; believable ranges per kind                                 |
| Progress      | progress photos with weight and pose                                | synced; plan-limited; removed with the account                     |
| Reminders     | phones, per-person reminders in local time, test push               | five-minute job; each reminder sent once; FCM tested on a fake     |
| Config        | `GET /config`: maintenance, update required, kill switches, plans   | switched live from `PUT /admin/settings`, no deploy                |
| Training data | admin list and download of photos people chose to contribute        | pseudonymous donors, GPS stripped on upload, export script         |
| Housekeeping  | nightly cron                                                        | tokens, deletion markers, counters, rate limits, codes, audit      |

## Layout

```
src/
  index.ts  app.ts  container.ts  env.ts
  core/        errors, ids, crypto, time, pagination, logger, rate limiters, schemas, validation, alerts, Google auth
  db/          sql helpers, synced-table (the revision/conflict SQL)
  lib/         pure maths: goals, insights, text, barcodes
  middleware/  request id, access log, errors, auth, admin, entitlements, rate limit
  config/      plans and limits (one place)
  modules/     <feature>/<feature>.{routes,service,repo,schemas}.ts + tests
migrations/    numbered D1 migrations
scripts/       bootstrap, render config, sync secrets, smoke test, content and food import, training export, secret scan (+ tests)
content/       sample workout content, and the meal plans (docs/meal-plans.md), for the importer
.github/       ci, deploy-stage, deploy-production, dependabot
```

Routes parse and respond, services hold the rules, repos hold the SQL. Everything outside the Worker (Google, billing,
Open Food Facts, Workers AI, the clock) sits behind an interface and is replaced by a fake in the tests.

## Honest status

- 643 tests plus 33 script tests; statements 98%, lines 99%, branches 92% (CI fails below 95 / 96 / 85). A fuzzer sends bad input to
  every operation in the API description (about 4,000 requests) and requires that nothing ever answers 500; separate tests cover SQL
  injection and one account reaching for another's data. Coverage says the code ran, not that it is right; the tests also check
  behaviour, and the security-relevant ones were mutation-checked by breaking the code and watching them fail.
- **Never run against Cloudflare itself yet.** Everything above ran in the local Workers runtime. The first deploy to stage is the
  real test of the pipeline, Workers AI, and the Open Food Facts client (see operations.md).
- **Written from documentation, tested against fakes, never run live:** Google Play billing and notifications, Firebase push, Resend
  email, Play Integrity and Cloudflare Stream signing. The mock store refuses to grant Pro in production.
- Content (videos, programs, South African food figures) has to be supplied and licensed; only tiny samples are included.
