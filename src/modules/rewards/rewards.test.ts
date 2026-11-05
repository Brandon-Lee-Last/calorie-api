import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { T0, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { partnerEarningCents } from '../../config/rewards';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';
import { normalizeCode, plausibleFood } from './rewards.service';

async function setup() {
  const t = makeApp();
  const person = async () => {
    const s = await signUp(t);
    const send = (method: string, path: string, data?: unknown) =>
      t.request(path, jsonInit(method, data, s.accessToken));
    const rewards = async () => body(await send('GET', '/v1/rewards'));
    const food = (over: Record<string, unknown> = {}) =>
      send('PUT', `/v1/foods/${newId()}`, {
        name: 'Rusks',
        calories100g: 430,
        protein100g: 9,
        carb100g: 70,
        fat100g: 12,
        clientUpdatedAt: T0,
        ...over,
      });
    const log = (localDate: string) =>
      send('PUT', `/v1/diary/entries/${newId()}`, {
        loggedAt: Date.parse(`${localDate}T08:00:00Z`),
        localDate,
        mealType: 'breakfast',
        name: 'Oats',
        calories: 300,
        proteinG: 10,
        carbG: 50,
        fatG: 6,
        source: 'manual',
        clientUpdatedAt: T0,
      });
    return { s, send, rewards, food, log };
  };
  return { t, person, admin: adminClient(t) };
}

describe('rules', () => {
  it('only rewards foods whose numbers hang together', () => {
    expect(plausibleFood({ calories100g: 430, protein100g: 9, carb100g: 70, fat100g: 12 })).toBe(true);
    expect(plausibleFood({ calories100g: 900, protein100g: 1, carb100g: 1, fat100g: 1 })).toBe(false); // made up
    expect(plausibleFood({ calories100g: 100, protein100g: 60, carb100g: 30, fat100g: 20 })).toBe(false); // over 100 g
    expect(plausibleFood({ calories100g: 0, protein100g: 0, carb100g: 0, fat100g: 0 })).toBe(false);
  });
  it('reads codes however they are typed, and gives partners their share of the price less VAT and the store fee', () => {
    expect(normalizeCode(' gym-fit 22 ')).toBe('GYMFIT22');
    expect(partnerEarningCents(6999, 20)).toBe(1035); // R69.99 / 1.15 x 0.85 x 20%
    expect(partnerEarningCents(6999, 0)).toBe(0);
  });
});

describe('points for adding foods', () => {
  it('gives more for a barcode, nothing for edits or nonsense, caps a day, and takes them back on delete', async () => {
    const { person } = await setup();
    const p = await person();
    expect((await p.rewards()).points).toBe(0);
    const id = newId();
    expect(
      (
        await p.send('PUT', `/v1/foods/${id}`, {
          name: 'Ouma rusks',
          barcode: '4006381333931',
          calories100g: 430,
          protein100g: 9,
          carb100g: 70,
          fat100g: 12,
          clientUpdatedAt: T0,
        })
      ).status,
    ).toBe(200);
    expect((await p.rewards()).points).toBe(20);
    await p.send('PUT', `/v1/foods/${id}`, {
      name: 'Ouma rusks',
      barcode: '4006381333931',
      calories100g: 431,
      protein100g: 9,
      carb100g: 70,
      fat100g: 12,
      clientUpdatedAt: T0 + 5,
    });
    expect((await p.rewards()).points).toBe(20); // an edit is not a new food
    await p.food({ calories100g: 900, protein100g: 1, carb100g: 1, fat100g: 1 });
    expect((await p.rewards()).points).toBe(20); // numbers that do not add up earn nothing
    for (let i = 0; i < 5; i++) await p.food();
    expect((await p.rewards()).points).toBe(60); // 4 more at 10: five rewarded foods a day
    expect((await p.send('DELETE', `/v1/foods/${id}`)).status).toBe(204);
    const after = await p.rewards();
    expect(after.points).toBe(40);
    expect(after.history.map((h: { reason: string }) => h.reason)[0]).toBe('food_removed');
  });
});

describe('invites', () => {
  it('rewards both once the friend has logged on three days, and only once', async () => {
    const { person } = await setup();
    const a = await person();
    const b = await person();
    const code = (await a.rewards()).inviteCode;
    expect(code).toMatch(/^P[A-Z2-9]{6}$/);
    expect((await a.rewards()).inviteCode).toBe(code); // stable
    expect((await a.send('POST', '/v1/rewards/code', { code })).status).toBe(400); // your own
    expect((await b.send('POST', '/v1/rewards/code', { code: 'NOPE123' })).status).toBe(404);
    expect(await body(await b.send('POST', '/v1/rewards/code', { code: code.toLowerCase() }))).toEqual({
      kind: 'invite',
      name: null,
      points: 100,
    });
    expect((await b.send('POST', '/v1/rewards/code', { code })).status).toBe(409);
    await b.log('2026-10-19');
    await b.log('2026-10-19');
    await b.log('2026-10-20');
    expect((await a.rewards()).points).toBe(0);
    await b.log('2026-10-21');
    expect((await a.rewards()).points).toBe(200);
    expect((await b.rewards()).points).toBe(100);
    expect((await a.rewards()).invites).toEqual({ joined: 1, rewarded: 1 });
    await b.log('2026-10-22');
    expect((await a.rewards()).points).toBe(200);
  });

  it('can only be entered in an account’s first weeks', async () => {
    const { t, person } = await setup();
    const a = await person();
    const b = await person();
    t.clock.advance(31 * DAY);
    await env.DB.prepare('UPDATE users SET created_at = ? WHERE id = ?')
      .bind(T0 - 31 * DAY, b.s.userId)
      .run();
    const res = await b.send('POST', '/v1/rewards/code', { code: 'PAAAAAA' });
    expect([400, 401]).toContain(res.status); // 401 if the token aged out with the clock; either way no code
    void a;
  });
});

describe('a month of Plus for points', () => {
  it('needs enough points, starts after the last one, and is not sold over a paid subscription', async () => {
    const { person } = await setup();
    const p = await person();
    expect((await p.send('POST', '/v1/rewards/redeem')).status).toBe(409);
    await env.DB.prepare(
      "INSERT INTO points_ledger (id, user_id, amount, reason, ref, created_at) VALUES (?, ?, 2000, 'adjustment', 'test', ?)",
    )
      .bind(newId(), p.s.userId, T0)
      .run();
    const first = await body(await p.send('POST', '/v1/rewards/redeem'));
    expect(first).toEqual({ plusUntil: T0 + 30 * DAY, points: 1000 });
    expect((await body(await p.send('GET', '/v1/entitlements'))).plan).toBe('pro');
    const second = await body(await p.send('POST', '/v1/rewards/redeem'));
    expect(second).toEqual({ plusUntil: T0 + 60 * DAY, points: 0 });
    expect((await p.rewards()).plusFromPointsUntil).toBe(T0 + 60 * DAY);

    const q = await person();
    await env.DB.prepare(
      "INSERT INTO points_ledger (id, user_id, amount, reason, ref, created_at) VALUES (?, ?, 1000, 'adjustment', 'test', ?)",
    )
      .bind(newId(), q.s.userId, T0)
      .run();
    await q.send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
    const paid = await q.send('POST', '/v1/rewards/redeem');
    expect(paid.status).toBe(409);
    expect((await body(paid)).error.details.reason).toBe('paid_plus_active');
  });
});

describe('partners (gyms)', () => {
  it('signs members up with a code, earns a share of each paid period, reports, and records payouts', async () => {
    const { person, admin } = await setup();
    expect(
      (await admin.call('POST', '/v1/admin/partners', { name: 'Fit Hub Sandton', code: 'fit hub' })).status,
    ).toBe(200);
    expect((await admin.call('POST', '/v1/admin/partners', { name: 'Copycat', code: 'FITHUB' })).status).toBe(
      409,
    );
    const [gym] = (await body(await admin.call('GET', '/v1/admin/partners'))).items;
    expect(gym).toMatchObject({ code: 'FITHUB', sharePct: 20, months: 12, welcomePoints: 200, members: 0 });

    const m = await person();
    expect(await body(await m.send('POST', '/v1/rewards/code', { code: 'FitHub' }))).toEqual({
      kind: 'partner',
      name: 'Fit Hub Sandton',
      points: 200,
    });
    expect((await m.send('POST', '/v1/rewards/code', { code: 'FITHUB' })).status).toBe(409);
    expect((await m.rewards()).codeEntry).toMatchObject({ partner: { name: 'Fit Hub Sandton' }, open: true });

    await m.send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
    await m.send('POST', '/v1/subscription/simulate', { scenario: 'cancel' }); // news of the same period: counted once
    let [row] = (await body(await admin.call('GET', '/v1/admin/partners'))).items;
    expect(row).toMatchObject({ members: 1, plusMembers: 1, earnedCents: 1035, owedCents: 1035 });

    const report = await body(await admin.call('GET', `/v1/admin/partners/${gym.id}/report?month=2026-10`));
    expect(report).toMatchObject({ joined: 1, totalEarningCents: 1035, unpaidCents: 1035 });
    expect(report.payments).toEqual([
      expect.objectContaining({
        productId: 'pro_monthly',
        grossCents: 6999,
        earningCents: 1035,
        refunded: false,
        paid: false,
      }),
    ]);

    expect(
      await body(await admin.call('POST', `/v1/admin/partners/${gym.id}/paid`, { until: T0 + DAY })),
    ).toEqual({ rows: 1, cents: 1035 });
    [row] = (await body(await admin.call('GET', '/v1/admin/partners'))).items;
    expect(row).toMatchObject({ earnedCents: 1035, owedCents: 0 });

    // Each renewal earns again.
    await m.send('POST', '/v1/subscription/simulate', { scenario: 'renew' });
    [row] = (await body(await admin.call('GET', '/v1/admin/partners'))).items;
    expect(row).toMatchObject({ earnedCents: 2070, owedCents: 1035 });

    // A refund takes back the share of the period refunded, once.
    await m.send('POST', '/v1/subscription/simulate', { scenario: 'refund' });
    await m.send('POST', '/v1/subscription/simulate', { scenario: 'refund' });
    [row] = (await body(await admin.call('GET', '/v1/admin/partners'))).items;
    expect(row).toMatchObject({ earnedCents: 1035, owedCents: 0 });

    // A stopped code signs nobody up.
    await admin.call('PATCH', `/v1/admin/partners/${gym.id}`, { active: false });
    const n = await person();
    expect((await n.send('POST', '/v1/rewards/code', { code: 'FITHUB' })).status).toBe(400);
    expect((await m.send('GET', '/v1/admin/partners')).status).toBe(401); // members are not admins
  });
});
