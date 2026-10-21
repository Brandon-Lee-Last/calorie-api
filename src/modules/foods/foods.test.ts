import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { FakeLookup, NUTELLA_LIKE } from '../../../test/helpers/foods';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';
import { MemoryRateLimiter } from '../../core/rate-limiter';
import { FakeClock } from '../../core/time';

async function setup() {
  await env.DB.exec('DELETE FROM foods WHERE user_id IS NULL'); // the shared catalogue persists between tests in this file
  const lookup = new FakeLookup({ [NUTELLA_LIKE.barcode]: NUTELLA_LIKE });
  const t = makeApp({ foodLookup: lookup });
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const food = (over: Record<string, unknown> = {}) => ({
    name: 'Gran’s Rusks',
    calories100g: 430,
    protein100g: 9,
    carb100g: 70,
    fat100g: 12,
    clientUpdatedAt: T0,
    ...over,
  }); // fmt: skip
  return { t, s, send, lookup, food };
}

describe('custom foods', () => {
  it('stores a food and works out the per-serving numbers', async () => {
    const { send, food } = await setup();
    const id = newId();
    const res = await send(
      'PUT',
      `/v1/foods/${id}`,
      food({ servingG: 40, servingLabel: '1 rusk', brand: 'Home' }),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      applied: true,
      record: {
        id,
        source: 'custom',
        isOwn: true,
        name: 'Gran’s Rusks',
        brand: 'Home',
        perServing: { calories: 172, proteinG: 3.6, carbG: 28, fatG: 4.8 },
      },
    });
  });
  it('has no per-serving figures when the serving size is unknown', async () => {
    const { send, food } = await setup();
    expect((await body(await send('PUT', `/v1/foods/${newId()}`, food()))).record.perServing).toBeNull();
  });
  it('is idempotent and later edits win', async () => {
    const { send, food } = await setup();
    const id = newId();
    await send('PUT', `/v1/foods/${id}`, food());
    await send('PUT', `/v1/foods/${id}`, food());
    expect(
      await body(await send('PUT', `/v1/foods/${id}`, food({ calories100g: 400, clientUpdatedAt: T0 + 5 }))),
    ).toMatchObject({ applied: true, record: { calories100g: 400 } });
    expect(
      await body(await send('PUT', `/v1/foods/${id}`, food({ calories100g: 1, clientUpdatedAt: T0 + 1 }))),
    ).toMatchObject({ applied: false, record: { calories100g: 400 } });
  });
  it('rejects impossible nutrition and bad barcodes', async () => {
    const { send, food } = await setup();
    for (const bad of [
      { calories100g: 2000 },
      { fat100g: 150 },
      { name: '' },
      { servingG: 0 },
      { barcode: 'abc' },
      { barcode: '4006381333932' },
    ]) {
      expect((await send('PUT', `/v1/foods/${newId()}`, food(bad))).status, JSON.stringify(bad)).toBe(422);
    }
  });
  it('does not allow two of your foods to share a barcode, until one is deleted', async () => {
    const { send, food } = await setup();
    const a = newId();
    const b = newId();
    expect((await send('PUT', `/v1/foods/${a}`, food({ barcode: '4006381333931' }))).status).toBe(200);
    const dup = await send('PUT', `/v1/foods/${b}`, food({ barcode: '4006381333931', name: 'Copy' }));
    expect(dup.status).toBe(409);
    await send('DELETE', `/v1/foods/${a}`);
    expect(
      (await send('PUT', `/v1/foods/${b}`, food({ barcode: '4006381333931', name: 'Copy' }))).status,
    ).toBe(200);
  });
  it('deleting hides it, repeatably', async () => {
    const { send, food } = await setup();
    const id = newId();
    await send('PUT', `/v1/foods/${id}`, food());
    expect((await send('DELETE', `/v1/foods/${id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/foods/${id}`)).status).toBe(204);
    expect((await send('GET', `/v1/foods/${id}`)).status).toBe(404);
  });
  it('are private to their owner', async () => {
    const { t, send, food } = await setup();
    const id = newId();
    await send('PUT', `/v1/foods/${id}`, food({ name: 'Secret sauce' }));
    const other = await signUp(t);
    expect((await send('GET', `/v1/foods/${id}`, undefined, other.accessToken)).status).toBe(404);
    expect((await send('PUT', `/v1/foods/${id}`, food(), other.accessToken)).status).toBe(409);
    expect(
      (await body(await send('GET', '/v1/foods/search?q=secret', undefined, other.accessToken))).items,
    ).toEqual([]);
    expect((await body(await send('GET', '/v1/foods/search?q=secret'))).items).toHaveLength(1);
    await send('DELETE', `/v1/foods/${id}`, undefined, other.accessToken);
    expect((await send('GET', `/v1/foods/${id}`)).status).toBe(200);
  });
});

describe('food search', () => {
  it('matches every word, ignoring case and accents, with your foods first', async () => {
    const { send, food, lookup, s } = await setup();
    await send('PUT', `/v1/foods/${newId()}`, food({ name: 'Droëwors', calories100g: 330 }));
    await send('PUT', `/v1/foods/${newId()}`, food({ name: 'Beef droewors spicy', brand: 'Biltong Bros' }));
    await send('PUT', `/v1/foods/${newId()}`, food({ name: 'Lamb chop' }));
    lookup.add({
      ...NUTELLA_LIKE,
      barcode: '0036000291452',
      externalId: '0036000291452',
      name: 'Droewors Original',
    });
    await send('GET', '/v1/foods/barcode/036000291452'); // caches it in the catalogue
    const names = async (q: string) =>
      (await body(await send('GET', `/v1/foods/search?q=${encodeURIComponent(q)}`))).items.map(
        (i: { name: string }) => i.name,
      );
    expect(await names('droewors')).toEqual(['Droëwors', 'Beef droewors spicy', 'Droewors Original']);
    expect(await names('DROËWORS spicy')).toEqual(['Beef droewors spicy']);
    expect(await names('biltong bros')).toEqual(['Beef droewors spicy']); // brand counts
    expect(await names('zebra')).toEqual([]);
    void s;
  });
  it('treats % and _ literally', async () => {
    const { send, food } = await setup();
    await send('PUT', `/v1/foods/${newId()}`, food({ name: '100% juice' }));
    await send('PUT', `/v1/foods/${newId()}`, food({ name: 'Plain bread' }));
    const hits = (await body(await send('GET', `/v1/foods/search?q=${encodeURIComponent('%%')}`))).items;
    expect(hits).toEqual([]); // "%%" normalises to nothing, so nothing matches, rather than everything
    const juice = (await body(await send('GET', '/v1/foods/search?q=100%25%20juice'))).items;
    expect(juice.map((i: { name: string }) => i.name)).toEqual(['100% juice']);
  });
  it('needs a real query and caps the result count', async () => {
    const { send, food } = await setup();
    expect((await send('GET', '/v1/foods/search?q=a')).status).toBe(422);
    expect((await send('GET', '/v1/foods/search')).status).toBe(422);
    for (let i = 0; i < 5; i++) await send('PUT', `/v1/foods/${newId()}`, food({ name: `Apple pie ${i}` }));
    expect((await body(await send('GET', '/v1/foods/search?q=apple&limit=3'))).items).toHaveLength(3);
    expect((await send('GET', '/v1/foods/search?q=apple&limit=500')).status).toBe(422);
  });
});

describe('barcode lookup', () => {
  it('fetches an unknown product once, then serves it from the catalogue', async () => {
    const { send, lookup } = await setup();
    const first = await send('GET', '/v1/foods/barcode/4006381333931');
    expect(first.status).toBe(200);
    const f = await body(first);
    expect(f).toMatchObject({
      source: 'openfoodfacts',
      isOwn: false,
      name: 'Hazelnut Spread',
      brand: 'Acme',
      calories100g: 539,
      perServing: { calories: 80.9 },
    });
    const second = await body(await send('GET', '/v1/foods/barcode/4006381333931'));
    expect(second.id).toBe(f.id);
    expect(lookup.calls).toEqual(['4006381333931']);
    expect((await send('GET', `/v1/foods/${f.id}`)).status).toBe(200); // catalogue foods are readable by id
  });
  it('shares the cache between users', async () => {
    const { t, send, lookup } = await setup();
    await send('GET', '/v1/foods/barcode/4006381333931');
    const other = await signUp(t);
    expect((await send('GET', '/v1/foods/barcode/4006381333931', undefined, other.accessToken)).status).toBe(
      200,
    );
    expect(lookup.calls).toHaveLength(1);
  });
  it('prefers your own food with that barcode', async () => {
    const { send, food } = await setup();
    const id = newId();
    await send('PUT', `/v1/foods/${id}`, food({ barcode: '4006381333931', name: 'My version' }));
    expect(await body(await send('GET', '/v1/foods/barcode/4006381333931'))).toMatchObject({
      id,
      name: 'My version',
      isOwn: true,
    });
  });
  it('treats a 12 digit UPC-A and its 13 digit form as the same product', async () => {
    const { send, lookup } = await setup();
    lookup.add({ ...NUTELLA_LIKE, barcode: '0036000291452', externalId: '0036000291452' });
    const a = await body(await send('GET', '/v1/foods/barcode/036000291452'));
    const b = await body(await send('GET', '/v1/foods/barcode/0036000291452'));
    expect(a.id).toBe(b.id);
    expect(lookup.calls).toEqual(['0036000291452']);
  });
  it('says 404 for an unknown product, 422 for a mistyped code, 502 when the service is down', async () => {
    const { send, lookup } = await setup();
    expect((await send('GET', '/v1/foods/barcode/5449000000996')).status).toBe(404);
    expect((await send('GET', '/v1/foods/barcode/4006381333932')).status).toBe(422);
    expect((await send('GET', '/v1/foods/barcode/abc')).status).toBe(422);
    lookup.fail = true;
    const res = await send('GET', '/v1/foods/barcode/96385074');
    expect(res.status).toBe(502);
    expect((await body(res)).error.code).toBe('upstream_failed');
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM foods WHERE barcode = '96385074'").first<{
      n: number;
    }>();
    expect(rows!.n).toBe(0); // a failed lookup caches nothing
  });
  it('limits how many lookups one person can make', async () => {
    const clock = new FakeClock(T0);
    const lookup = new FakeLookup();
    const t = makeApp({ clock, foodLookup: lookup, rateLimiter: new MemoryRateLimiter(clock) });
    const s = await signUp(t);
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await t.request('/v1/foods/barcode/5449000000996', { headers: authed(s.accessToken) })).status;
    expect(last).toBe(429);
  });
  it('requires sign-in', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/foods/barcode/4006381333931')).status).toBe(401);
    expect((await t.request('/v1/foods/search?q=milk')).status).toBe(401);
  });
});
