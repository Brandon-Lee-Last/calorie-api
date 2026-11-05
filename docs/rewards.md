# Pango Points, invites and partner (gym) codes

All the numbers live in `src/config/rewards.ts`; change them there.

## Pango Points

| How                                                    | Points                                        | Limits                                                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new food to the food list (with a barcode)       | 10 (20)                                       | 5 rewarded foods a day; the numbers must add up (energy within 35% of 4/4/9 kcal per g of protein, carbs, fat); deleting the food takes the points back |
| Invite a friend who then logs food on 3 different days | 200 to you, 100 to them                       | 10 rewarded invites a month per person; the friend enters your code within 30 days of joining                                                           |
| Join with a partner's code                             | the partner's welcome points (200 by default) | one partner per person, within 30 days of joining                                                                                                       |

1,000 points buy a month (30 days) of Plus, stacking after any month already bought. Not sold while a Google Play
subscription is running (those points would be wasted). Months bought with points count as Plus everywhere the API
checks (`GET /v1/entitlements` shows `plan: pro`, `willRenew: false`).

Every change to a balance is a row in `points_ledger`, unique per (person, reason, thing), so an award can never be
given twice however often a hook runs. Spending checks the balance in the same SQL statement as it spends.

App routes: `GET /v1/rewards` (balance, own invite code, history, rules), `POST /v1/rewards/code` (a friend's or a
partner's code), `POST /v1/rewards/redeem`.

## Partner (gym) codes

A partner has its own code (for example `FITHUB`). A member who enters it in their first 30 days is linked to the
partner for good. Every **paid** Plus period of that member (the first payment after any free trial, and each renewal)
earns the partner its share, for the first `months` after the member joined (12 by default; 0 is for as long as they
pay):

    share = price / 1.15 (VAT) x 0.85 (Google Play's fee) x share %

At the default 20%, a R69.99 month earns the gym R10.35. Google Play does not tell the server what a person paid, so the
prices come from `PLUS_PRICES_CENTS` (JSON, e.g. `{"pro_monthly":6999,"pro_yearly":59999}`, set as a Worker variable)
and **must match the prices in the Play Console**. A refund takes back the share of the refunded period. If a member
deletes their account, what the partner already earned stays (the row keeps no link to the person).

### Running it: the Partners workflow

In GitHub, open Actions, then **Partners**, then **Run workflow**. Pick the server (stage to try things, production
for real gyms) and an action; the answer appears on the run's summary page.

- **create**: name, code, and optionally share %, months, welcome points and a contact.
- **list**: every partner with members, members on Plus, earned and still owed.
- **report**: a month's statement for one code (to send to the gym with the payment).
- **paid**: after you pay a gym, mark everything owed before a date as paid.
- **stop**: no new sign-ups with that code; existing members still earn the gym its share.

The same script runs from a terminal: `API_BASE=... ADMIN_API_KEY=... node scripts/partners.mjs list`.

### What the server does not do

- **Paying gyms** is up to you (EFT); the server only works out what is owed and records that you paid.
- **The agreement with each gym** (share, how long, when you pay, what happens to refunds) should be in writing, and
  your accountant should confirm how the payments are treated for tax. The defaults here are a starting point.
