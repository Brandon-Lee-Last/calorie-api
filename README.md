# Calorie API

The backend for the calorie app: accounts, sync, food database, subscriptions, workouts and media, AI text logging,
and insights. **Hono on Cloudflare Workers**, **D1** for data, **R2** for files, **Workers AI** for text features.

The photo scanner is not here. The custom model runs on the phone (see the `local-calorie-ai-model` and `calorie-app`
repos); this API stores what people choose to keep and learns from how often they correct the model.

```
npm install
npm test                 # 363 tests, in the real Workers runtime against a real D1
npm run test:scripts     # tests for the deploy scripts (plain Node)
npm run dev              # local server (copy .dev.vars.example to .dev.vars first)
npm run check            # typecheck + formatting + all tests
```

| Read this                                    | For                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | how it is built and why                                                 |
| [docs/api-guide.md](docs/api-guide.md)       | for the app team: auth, offline sync, subscriptions, workouts           |
| [docs/operations.md](docs/operations.md)     | setting up Cloudflare and GitHub, deploying, rollback, what is not done |
| `GET /v1/openapi.json`                       | the full API contract (generate the app's client from it)               |

## What is built

| Area          | Endpoints                                                           | Notes                                                            |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Auth          | anonymous account, Google sign-in and linking, refresh, logout      | rotating single-use refresh tokens, replay revokes the session   |
| Me            | profile, body stats, calorie and macro goals                        | Mifflin-St Jeor recommendation with a safety floor               |
| Diary         | entries, day summaries, recent foods, meal photos (R2)              | client-made ids, idempotent, later edit wins                     |
| Body          | weight, water                                                       | weight keeps the profile and goals in step                       |
| Foods         | custom foods, accent-insensitive search, barcode lookup             | Open Food Facts on demand, cached in a shared catalogue          |
| Scans         | what the on-device model said vs what the person kept               | consent-gated photo contribution; admin accuracy report          |
| Sync          | `pull?since=` and `push` over all synced records                    | per-user revision counter, no clock dependence                   |
| Subscriptions | entitlements, verify, restore, simulate (stage)                     | **mock store**; Google Play is a documented stub                 |
| Workouts      | exercise library, free and Pro programs, enrolment, session logging | per-workout free samples inside Pro programs                     |
| Media         | signed expiring links, Range and ETag, Pro gating                   | R2; external links; Stream not yet                               |
| AI            | text meal parsing                                                   | Workers AI; estimates only; metered; failed calls not charged    |
| Insights      | overview, weekly summary                                            | Pro adds depth and an AI-written summary built from numbers only |
| Account       | data export, permanent delete                                       | removes every row and file; old tokens die at once               |
| Admin         | media, exercises, programs, accuracy, maintenance                   | key-protected; whole-program import is atomic                    |
| Housekeeping  | nightly cron                                                        | expired tokens, old deletion markers, old counters               |

## Layout

```
src/
  index.ts  app.ts  container.ts  env.ts
  core/        errors, ids, crypto, time, pagination, logger, rate limiter, schemas, validation
  db/          sql helpers, synced-table (the revision/conflict SQL)
  lib/         pure maths: goals, insights, text, barcodes
  middleware/  request id, access log, errors, auth, admin, entitlements, rate limit
  config/      plans and limits (one place)
  modules/     <feature>/<feature>.{routes,service,repo,schemas}.ts + tests
migrations/    numbered D1 migrations
scripts/       bootstrap, render config, sync secrets, smoke test, content import (+ tests)
content/       sample workout content for the importer
.github/       ci, deploy-stage, deploy-production, dependabot
```

Routes parse and respond, services hold the rules, repos hold the SQL. Everything outside the Worker (Google, billing,
Open Food Facts, Workers AI, the clock) sits behind an interface and is replaced by a fake in the tests.

## Honest status

- 363 tests plus 9 script tests; statements 97%, lines 98%, branches 89% (CI fails below 95 / 96 / 85).
  Coverage says the code ran, not that it is right; the tests also check behaviour, and the security-relevant ones were
  mutation-checked by breaking the code and watching them fail.
- **Never run against Cloudflare itself yet.** Everything above ran in the local Workers runtime. The first deploy to
  stage is the real test of the pipeline, Workers AI, and the Open Food Facts client (see operations.md).
- Billing is a mock, and the mock refuses to grant Pro in production. Google Play is not implemented.
- Content (videos, programs) has to be supplied and licensed; only tiny sample text is included.
