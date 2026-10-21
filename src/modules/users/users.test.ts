import { describe, expect, it } from 'vitest';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const CURRENT_YEAR = new Date(T0).getUTCFullYear();

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const patch = (data: unknown) => t.request('/v1/me/profile', jsonInit('PATCH', data, s.accessToken));
  const get = (path: string) => t.request(path, { headers: authed(s.accessToken) });
  return { t, s, patch, get };
}

describe('GET /me', () => {
  it('describes a new anonymous account with default goals', async () => {
    const { get, s } = await setup();
    const me = await body(await get('/v1/me'));
    expect(me).toMatchObject({
      id: s.userId,
      isAnonymous: true,
      providers: [],
      displayName: null,
      email: null,
    });
    expect(me.profile).toMatchObject({
      timezone: 'UTC',
      units: 'metric',
      goal: 'maintain',
      sex: null,
      birthYear: null,
      onboardedAt: null,
      goals: { calories: 2000, proteinG: 125, carbG: 225, fatG: 67, custom: false },
    }); // fmt: skip
  });
  it('requires sign-in', async () => {
    const t = makeApp();
    expect((await t.request('/v1/me')).status).toBe(401);
    expect((await t.request('/v1/me/profile')).status).toBe(401);
    expect(
      (await t.request('/v1/me/goals', jsonInit('PUT', { calories: 2000, proteinG: 1, carbG: 1, fatG: 1 })))
        .status,
    ).toBe(401);
  });
  it('keeps accounts apart', async () => {
    const t = makeApp();
    const a = await signUp(t);
    const b = await signUp(t);
    await t.request('/v1/me/profile', jsonInit('PATCH', { heightCm: 190, units: 'imperial' }, a.accessToken));
    const pb = await body(await t.request('/v1/me/profile', { headers: authed(b.accessToken) }));
    expect(pb).toMatchObject({ heightCm: null, units: 'metric' });
  });
});

describe('PATCH /me', () => {
  it('sets and clears the display name', async () => {
    const { t, s } = await setup();
    const set = await body(
      await t.request('/v1/me', jsonInit('PATCH', { displayName: '  Thandi ' }, s.accessToken)),
    );
    expect(set.displayName).toBe('Thandi');
    const cleared = await body(
      await t.request('/v1/me', jsonInit('PATCH', { displayName: null }, s.accessToken)),
    );
    expect(cleared.displayName).toBeNull();
    expect((await t.request('/v1/me', jsonInit('PATCH', { displayName: '' }, s.accessToken))).status).toBe(
      422,
    );
  });
});

describe('PATCH /me/profile', () => {
  it('changes only what is sent', async () => {
    const { patch } = await setup();
    await patch({ heightCm: 175, locale: 'en-ZA' });
    const p = await body(await patch({ units: 'imperial' }));
    expect(p).toMatchObject({ heightCm: 175, locale: 'en-ZA', units: 'imperial', timezone: 'UTC' });
  });
  it('recalculates goals once the body stats are complete', async () => {
    const { patch } = await setup();
    const partial = await body(await patch({ heightCm: 180, weightKg: 80 }));
    expect(partial.goals.calories).toBe(2000); // still missing birth year and activity
    const p = await body(
      await patch({
        sex: 'male',
        birthYear: CURRENT_YEAR - 30,
        activityLevel: 'moderate',
        timezone: 'Africa/Johannesburg',
      }),
    );
    expect(p.goals).toMatchObject({ calories: 2760, custom: false });
    expect(p.timezone).toBe('Africa/Johannesburg');
  });
  it('follows a changing goal type and rate', async () => {
    const { patch } = await setup();
    await patch({
      sex: 'male',
      birthYear: CURRENT_YEAR - 30,
      heightCm: 180,
      weightKg: 80,
      activityLevel: 'moderate',
    });
    const lose = await body(await patch({ goal: 'lose', goalRateKgPerWeek: 0.5 }));
    expect(lose.goals.calories).toBe(2210);
    expect(lose.goals.proteinG).toBe(Math.round((2210 * 0.3) / 4));
  });
  it('does not touch goals the user set by hand', async () => {
    const { patch, t, s } = await setup();
    await t.request(
      '/v1/me/goals',
      jsonInit('PUT', { calories: 1800, proteinG: 140, carbG: 160, fatG: 60 }, s.accessToken),
    );
    const p = await body(
      await patch({
        sex: 'male',
        birthYear: CURRENT_YEAR - 30,
        heightCm: 180,
        weightKg: 80,
        activityLevel: 'moderate',
      }),
    );
    expect(p.goals).toEqual({ calories: 1800, proteinG: 140, carbG: 160, fatG: 60, custom: true });
  });
  it('rejects values outside sensible ranges, and writes nothing', async () => {
    const { patch, get } = await setup();
    for (const bad of [
      { heightCm: 10 },
      { weightKg: 1000 },
      { goalRateKgPerWeek: 3 },
      { units: 'stones' },
      { locale: 'not a locale' },
      { sex: 'robot' },
    ]) {
      expect((await patch(bad)).status).toBe(422);
    }
    expect((await body(await get('/v1/me/profile'))).heightCm).toBeNull();
  });
  it('rejects unknown timezones and under-age or implausible birth years', async () => {
    const { patch } = await setup();
    const tz = await patch({ timezone: 'Mars/Olympus' });
    expect(tz.status).toBe(422);
    expect((await body(tz)).error.details[0].path).toBe('timezone');
    expect((await patch({ birthYear: CURRENT_YEAR - 12 })).status).toBe(422);
    expect((await patch({ birthYear: CURRENT_YEAR - 13 })).status).toBe(200);
    expect((await patch({ birthYear: 1900 })).status).toBe(422);
  });
  it('lets optional fields be cleared with null', async () => {
    const { patch } = await setup();
    await patch({ sex: 'female', targetWeightKg: 60 });
    const p = await body(await patch({ sex: null, targetWeightKg: null }));
    expect(p).toMatchObject({ sex: null, targetWeightKg: null });
  });
  it('marks onboarding done, once, and can undo it', async () => {
    const { patch, t } = await setup();
    const done = await body(await patch({ onboarded: true }));
    expect(done.onboardedAt).toBe(T0);
    t.clock.advance(60_000);
    expect((await body(await patch({ onboarded: true }))).onboardedAt).toBe(T0); // not moved
    expect((await body(await patch({ onboarded: false }))).onboardedAt).toBeNull();
  });
});

describe('goals', () => {
  it('can be set by hand within limits', async () => {
    const { t, s } = await setup();
    const ok = await t.request(
      '/v1/me/goals',
      jsonInit('PUT', { calories: 2200, proteinG: 150, carbG: 250, fatG: 70 }, s.accessToken),
    );
    expect(ok.status).toBe(200);
    expect((await body(ok)).goals).toEqual({
      calories: 2200,
      proteinG: 150,
      carbG: 250,
      fatG: 70,
      custom: true,
    });
    for (const bad of [{ calories: 100 }, { calories: 99999 }, { proteinG: -1 }, { fatG: 1.5 }]) {
      const res = await t.request(
        '/v1/me/goals',
        jsonInit('PUT', { calories: 2000, proteinG: 100, carbG: 100, fatG: 50, ...bad }, s.accessToken),
      );
      expect(res.status).toBe(422);
    }
  });
  it('recommendation lists what the profile is missing', async () => {
    const { get } = await setup();
    const res = await get('/v1/me/goals/recommendation');
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error.details).toEqual({
      missing: ['birthYear', 'heightCm', 'weightKg', 'activityLevel'],
      reason: 'profile_incomplete',
    });
  });
  it('recommendation and apply give the same numbers, and apply re-enables auto goals', async () => {
    const { patch, get, t, s } = await setup();
    await patch({
      sex: 'female',
      birthYear: CURRENT_YEAR - 30,
      heightCm: 165,
      weightKg: 60,
      activityLevel: 'light',
    });
    const rec = await body(await get('/v1/me/goals/recommendation'));
    expect(rec).toMatchObject({ bmr: 1320, floorApplied: false });
    await t.request(
      '/v1/me/goals',
      jsonInit('PUT', { calories: 1500, proteinG: 100, carbG: 150, fatG: 50 }, s.accessToken),
    );
    const applied = await body(
      await t.request('/v1/me/goals/apply-recommendation', jsonInit('POST', undefined, s.accessToken)),
    );
    expect(applied.goals).toEqual({
      calories: rec.calories,
      proteinG: rec.proteinG,
      carbG: rec.carbG,
      fatG: rec.fatG,
      custom: false,
    });
    const later = await body(await patch({ weightKg: 55 }));
    expect(later.goals.calories).toBeLessThan(rec.calories);
  });
});
