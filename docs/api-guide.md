# Guide for the app team

Everything is under `/v1`. The exact request and response shapes are in `GET /v1/openapi.json`; this page is about how the
pieces fit together. Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`: show `message`, branch
on `code`, and quote `requestId` in bug reports.

## Signing in

1. **First launch**: `POST /auth/anonymous` with an optional `deviceLabel`. Keep `refreshToken` in secure storage
   (expo-secure-store) and `accessToken` in memory. There is no sign-up screen to get through.
2. **Every request**: `Authorization: Bearer <accessToken>`.
3. **Access tokens last 15 minutes.** On `401` with `error.code === "token_expired"`, call `POST /auth/refresh` with the refresh token,
   **save the new refresh token before doing anything else** (the old one stops working), and retry the request once.
   Two requests refreshing at once is the usual way to get this wrong: share one in-flight refresh.
4. `401` with `unauthorized` from `/auth/refresh` means the session is over (revoked, expired after 90 idle days, or the account was deleted):
   go back to the start. A phone that lost the response to a refresh may retry with the old token within 10 seconds.
5. **Google**: get an ID token from Google Sign-In and `POST /auth/google` while signed in anonymously. The Google account is linked and the
   data stays. If that Google account already has data you get `409` with `details.reason === "identity_in_use"`: ask the person, and
   if they agree call again with `discardAnonymousData: true`.
6. `POST /auth/logout` with the refresh token on sign-out.

## Offline first: how sync works

Keep a local database. Every record you create gets an id from the phone (a UUID or ULID) and a `clientUpdatedAt` (the phone's clock,
in ms). Records: `diary_entry`, `weight`, `water`, `food` (your custom ones), `workout_session`.

- **Writing**: put changes in a local queue; send them with `POST /sync/push` (up to 50 ops: `{type, id, op: "upsert"|"delete", data}` where
  `data` is the same body as the matching `PUT`). Each op gets its own result: `applied`, `stale` (the server already has a newer edit:
  replace your copy with the returned `record`), `noop`, or `error` (don't retry unchanged; fix or drop it). Resending is always safe.
- **Reading**: `GET /sync/pull?since=<rev>` returns changes oldest first and a new `rev`. Store `rev`; while `hasMore` is true, pull again
  immediately. A record with `deletedAt` set is a deletion. Start new devices with `since=0`.
- **`409 resync_required`**: the device was away so long that deletion markers were cleaned up. Clear the local synced data and pull from `0`.
- **Conflicts**: the later `clientUpdatedAt` wins, per record. The server will not believe a clock that is more than 5 minutes ahead.
- The single-record endpoints (`PUT /diary/entries/{id}` and so on) do the same thing one at a time and are fine while online.
- Dates: send `localDate` (`YYYY-MM-DD`) in the person's timezone along with `loggedAt`; "today" is always decided by the phone and
  the profile `timezone`.
- Meal photos are not part of sync: upload with `PUT /diary/entries/{id}/photo` (raw bytes, resize to about 1024 px first) after the entry
  exists; the entry's `hasPhoto` tells other devices to fetch it.

## Logging food

| Way             | Calls                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photo scan      | run the on-device model; show the result with a portion control; save a `diary_entry` (`source: "scan"`) and report `PUT /scans/{id}` (what the model said, what was kept, `outcome`). Do the report in the background; it never blocks. |
| Barcode         | `GET /foods/barcode/{code}` (404 = unknown, 502 = lookup service down, try again) then log it as `source: "barcode"`. Credit Open Food Facts.                                                                                            |
| Search / recent | `GET /foods/search?q=`, `GET /diary/recent`                                                                                                                                                                                              |
| Custom food     | `PUT /foods/{id}`                                                                                                                                                                                                                        |
| Type it         | `POST /ai/parse-meal` returns **estimates** to confirm and edit, then save as `source: "ai_text"`                                                                                                                                        |
| Quick add       | a diary entry with just calories (`source: "quick_add"`)                                                                                                                                                                                 |

`GET /diary/summary?from&to` gives per-day totals (with water) for charts; `GET /insights/overview` and `/insights/weekly` give streaks and weeks.

## Plans, limits and paywalls

Call `GET /entitlements` on start and after any purchase. It returns `plan`, `status`, `expiresAt`, `willRenew`, `inGrace`, `isTrial`,
`limits` and today's `usage`.

- **Scans per day** (`limits.scansPerDay`, `usage.scans`): **you enforce it in the app**; the server only counts.
- **AI text**: the server enforces; `429 quota_exceeded` when used up (failed calls are not charged).
- **Pro content**: `402 subscription_required` means show the paywall. Programs and workouts also carry `locked` so you can draw the lock first.
- Show `inGrace` as "fix your payment" (Pro still works), and `status: "on_hold"` or `"expired"` as a way back in.

**Buying**: list `GET /subscription` products, start the Google Play purchase, then `POST /subscription/verify {productId, purchaseToken}` and
refresh entitlements. `POST /subscription/restore` for "restore purchases". **Until the Play account exists** use the mock store:
verify tokens like `mock_pro_monthly_active`, `..._trial`, `..._canceled`, `..._grace`, `..._hold`, `..._expired`, `..._refunded`
(add `_anything` to make a fresh one), or drive a live subscription on stage with `POST /subscription/simulate`
(`subscribe`, `renew`, `cancel`, `expire`, `grace`, `hold`, `refund`). Production ignores both.

## Workouts

`GET /programs` (free and Pro, with `locked`), `GET /programs/{slug}` (weeks, days, workouts), `GET /workouts/{id}` (exercises with sets, reps,
rest), `POST /programs/{slug}/enroll`, `GET /programs/current` (progress and the next workout), `PUT /training/sessions/{id}` to log a workout
(include `programId` and `workoutId` so progress moves; finishing the last workout completes the program). Exercise library: `GET /exercises`.

**Video and images**: `POST /media/{id}/access` returns a `url` (valid for an hour) to give to the player; it supports seeking. Ask just before playing.
`402` for Pro media on a free account.

## Account and privacy

`GET /account/export` downloads everything as JSON. `DELETE /account` with `{"confirm":"DELETE MY ACCOUNT"}` erases the account permanently
(a store subscription must be cancelled in the store; the response says so). Contributing scan photos to improve the model is opt-in:
send `contributeConsent: true` on the scan report, then `PUT /scans/{id}/photo`; withdraw by reporting the scan again with `false`.

## Limits worth knowing

JSON bodies up to 1 MB; photos up to 3 MB. Lists have date-range caps (62 days for diary entries, 366 for summaries and logs). The app
should back off on `429` and honour `Retry-After`.
