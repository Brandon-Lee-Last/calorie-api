import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';

const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const scan = (over: Record<string, unknown> = {}) => ({
    modelVersion: 'nutrition_v1',
    foodProbability: 0.97,
    predicted: { calories: 410, massG: 230, fatG: 15, carbG: 40, proteinG: 28 },
    outcome: 'saved',
    final: { calories: 410, massG: 230, fatG: 15, carbG: 40, proteinG: 28 },
    portion: 1,
    contributeConsent: false,
    clientCreatedAt: T0,
    ...over,
  }); // fmt: skip
  const photo = (id: string, token = s.accessToken, type = 'image/jpeg', bytes: Uint8Array = jpeg()) =>
    t.request(`/v1/scans/${id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': type, ...authed(token) },
      body: bytes,
    });
  return { t, s, send, scan, photo };
}

describe('scan events', () => {
  it('records a prediction and what the person kept', async () => {
    const { send, scan } = await setup();
    const id = newId();
    const res = await send('PUT', `/v1/scans/${id}`, scan());
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      id,
      modelVersion: 'nutrition_v1',
      outcome: 'saved',
      foodProbability: 0.97,
      portion: 1,
      contributeConsent: false,
      hasContributedPhoto: false,
      predicted: { calories: 410, massG: 230, fatG: 15, carbG: 40, proteinG: 28 },
    }); // fmt: skip
  });
  it('can be repeated, and an edit after saving updates the outcome', async () => {
    const { send, scan, s } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan());
    const edited = await body(
      await send(
        'PUT',
        `/v1/scans/${id}`,
        scan({
          outcome: 'edited',
          portion: 1.5,
          final: { calories: 615, massG: 345, fatG: 22, carbG: 60, proteinG: 42 },
        }),
      ),
    );
    expect(edited).toMatchObject({
      outcome: 'edited',
      portion: 1.5,
      final: { calories: 615 },
      predicted: { calories: 410 },
    });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM scan_events WHERE user_id = ?')
      .bind(s.userId)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
  it('accepts a photo that was rejected as not food, with no prediction', async () => {
    const { send, scan } = await setup();
    const res = await body(
      await send(
        'PUT',
        `/v1/scans/${newId()}`,
        scan({ outcome: 'not_food', foodProbability: 0.02, predicted: null, final: null, portion: null }),
      ),
    );
    expect(res).toMatchObject({ outcome: 'not_food', predicted: null, final: null, foodProbability: 0.02 });
  });
  it('rejects values that cannot be real', async () => {
    const { send, scan } = await setup();
    for (const bad of [
      { foodProbability: 1.5 },
      { outcome: 'maybe' },
      { modelVersion: '' },
      { portion: 0 },
      { predicted: { calories: -5, massG: 1, fatG: 1, carbG: 1, proteinG: 1 } },
    ]) {
      expect((await send('PUT', `/v1/scans/${newId()}`, scan(bad))).status, JSON.stringify(bad)).toBe(422);
    }
  });
  it('keeps scans private', async () => {
    const { t, send, scan } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan());
    const other = await signUp(t);
    expect((await send('GET', `/v1/scans/${id}`, undefined, other.accessToken)).status).toBe(404);
    expect(
      (await send('PUT', `/v1/scans/${id}`, scan({ outcome: 'discarded' }), other.accessToken)).status,
    ).toBe(409);
    expect((await body(await send('GET', `/v1/scans/${id}`))).outcome).toBe('saved');
    expect((await t.request(`/v1/scans/${id}`)).status).toBe(401);
  });
});

describe('contributed photos', () => {
  it('are refused unless the person agreed', async () => {
    const { send, scan, photo } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan({ contributeConsent: false }));
    const res = await photo(id);
    expect(res.status).toBe(400);
    expect((await body(res)).error.details.reason).toBe('no_consent');
    expect((await photo(newId())).status).toBe(404);
  });
  it('are stored under the user when consent was given, and removed when it is withdrawn', async () => {
    const { send, scan, photo, s } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan({ contributeConsent: true }));
    const res = await photo(id);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ hasContributedPhoto: true, contributeConsent: true });
    const key = `contrib/${s.userId}/${id}.jpg`;
    expect(await env.MEDIA.head(key)).not.toBeNull();

    const withdrawn = await body(await send('PUT', `/v1/scans/${id}`, scan({ contributeConsent: false })));
    expect(withdrawn).toMatchObject({ contributeConsent: false, hasContributedPhoto: false });
    expect(await env.MEDIA.head(key)).toBeNull();
  });
  it('can be withdrawn on their own', async () => {
    const { send, scan, photo, s } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan({ contributeConsent: true }));
    await photo(id);
    expect((await send('DELETE', `/v1/scans/${id}/photo`)).status).toBe(204);
    expect(await env.MEDIA.head(`contrib/${s.userId}/${id}.jpg`)).toBeNull();
    expect((await body(await send('GET', `/v1/scans/${id}`))).hasContributedPhoto).toBe(false);
    expect((await send('DELETE', `/v1/scans/${id}/photo`)).status).toBe(204);
  });
  it('must be real images and belong to the uploader', async () => {
    const { t, send, scan, photo } = await setup();
    const id = newId();
    await send('PUT', `/v1/scans/${id}`, scan({ contributeConsent: true }));
    expect((await photo(id, undefined, 'image/jpeg', new TextEncoder().encode('not an image'))).status).toBe(
      400,
    );
    expect((await photo(id, undefined, 'text/plain')).status).toBe(400);
    const other = await signUp(t);
    expect((await photo(id, other.accessToken)).status).toBe(404);
  });
});
