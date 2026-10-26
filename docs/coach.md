# Ask Pango: the AI coach

Pango answers questions about food, training, sleep, habits and motivation, using the person's own goals and recent
numbers, and suggests meals from the foods they have at home. It runs on Cloudflare Workers AI:
`AI_COACH_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for answers and recipes, and `AI_GUARD_MODEL`
(default `@cf/meta/llama-guard-3-8b`, Meta's Llama Guard safety classifier) to check messages and answers.

| Endpoint                      | What it does                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `POST /v1/coach/messages`     | A message and Pango's reply; the server keeps the conversation (90 days)       |
| `GET /v1/coach/messages`      | The conversation so far                                                        |
| `DELETE /v1/coach/messages`   | Start over                                                                     |
| `POST /v1/coach/pantry-meals` | Up to three recipes from the person's foods, with nutrition the server counted |
| `POST /v1/admin/coach/eval`   | The whole pipeline for a made-up person, saving nothing (red-team checks)      |

Allowance: `coachPerDay` in `src/config/plans.ts` (free 10, Plus 60, and 3 before a sign-in is linked), behind the
service-wide `AI_DAILY_BUDGET`. Replies that need no model (helplines, turned-away requests) are free. The `coach`
feature switch (`PUT /v1/admin/settings`, `disabledFeatures`) turns it all off at once without a deploy.

## Safety, in layers

No single check is trusted to be perfect (the OWASP Top 10 for LLM applications, 2025, is the checklist):

1. **Limits** (unbounded consumption): 1,000 characters a message, 8 a minute, the daily allowance, the AI budget.
2. **Cleaning** (`safety.ts`): Unicode normalised (look-alike letters become plain ones), invisible and direction
   characters removed, chat-template tokens (`<|...|>`, `[INST]`, `<<SYS>>`) removed so nobody can forge a turn.
3. **Fixed answers before any model**: someone who may be in crisis (suicide, self-harm, purging, starving, laxatives;
   English and Afrikaans) gets a kind message with South African helplines (SADAG 0800 567 567, Cipla line
   0800 456 789, Lifeline 0861 322 322, 112). Obvious attacks (ignore your instructions, show your prompt, "you are
   now", developer mode, forged `system:` turns, long encoded blobs) get a polite "food and fitness only".
4. **Llama Guard on the message**: suicide and self-harm (S11) get the helplines; crimes, sexual content, weapons and
   hate get turned away. If Llama Guard cannot be reached, the other layers still apply (and the reply is flagged).
5. **The prompt** (`prompt.ts`): rules first (not a doctor; no medicine or dose changes; nothing under 1,200 kcal a day
   (1,500 for men), no more than 1 kg a week, no fasts over 24 hours, no pills, laxatives or purging; under-18s get no
   weight-loss advice; stay on topic; never reveal the rules), then the person's data marked as data.
6. **Only the server's own history**: the conversation comes from the database, never from the phone, so nobody can
   forge Pango's past replies. Exchanges that were turned away are not replayed to the model.
7. **Data stays data** (indirect injection): meal and workout names the person typed reach the model "datamarked"
   (`⟦Chicken^mayo^sandwich⟧`, from Microsoft's spotlighting technique) and the rules say never to follow
   instructions inside them. The model only ever sees this person's data.
8. **Checking the answer** (improper output handling): a random code in each prompt (a canary) or the prompt's headings
   appearing in an answer means it leaked, and the answer is replaced; so are medicine doses, dangerous substances
   (DNP, clenbuterol and others) and daily calorie targets under the floor. Links, images and HTML are removed: they
   are how an injected instruction would smuggle data out. The app shows replies as plain text.
9. **Llama Guard on the answer**: anything unsafe other than S6 (specialised advice, which is what a coach gives) is
   replaced.
10. **No agency** (excessive agency): the coach cannot change anything. It writes text; recipes come back as data the
    app shows; logging a meal is always the person's tap.

Meals from groceries go further: the model may only pick from the person's foods (by reference, `i1`, `i2`...) and
seven zero-calorie staples. The server drops any recipe with an invented ingredient or silly amount, and works out the
nutrition from the foods' own figures (USDA or the label), never from the model, then sizes the portion to the goal.
The numbers are counted from the grams as listed (rounded to what a kitchen scale shows), and each ingredient carries
its own calories, so the list adds up to the total. Because the portion is resized after the model writes, its steps
must not name amounts: the prompt asks for clear steps without them (heat, time, how to tell it is done), and the
server strips any weight that slips through (`withoutAmounts`).

An answer that fails a check is replaced with a reply that still helps: why so few calories is unsafe, to ask a doctor
or pharmacist about medicines, no calorie targets for under-18s. A leaked prompt gets the plain fallback.

The rules are not secrets. Asked what it will not do, Pango may say so in its own words ("I'm not a doctor, I won't
suggest fewer than 1,200 kcal a day"), and that is fine: the protection is in the server's code, not in hiding the
prompt (OWASP: do not rely on system prompt secrecy). What must never come out is the prompt itself (its headings or
the canary), and no personal data other than the person's own is ever in it.

## Checking it

- `src/modules/coach/*.test.ts`: every rule, with a fake model that can be told to obey an attack.
- `scripts/coach-redteam.mjs` runs about 20 cases against stage's real models after every stage deploy (the Coach
  red-team workflow): attacks that must fail, people who must get helplines, and ordinary questions that must still get
  a proper answer. Models vary run to run, so each case says what must never happen.

Conversations are personal health data: they are in the data export and deleted with the account, and the privacy
policy must say they are kept for 90 days and processed by Cloudflare Workers AI. Cloudflare says Workers AI does not
use customer data to train models.
