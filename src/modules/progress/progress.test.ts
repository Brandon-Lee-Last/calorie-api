import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { T0, authed, body, jsonInit, linkAccount, makeApp, signUp } from '../../../test/helpers/app';
import { PLANS } from '../../config/plans';

const TODAY = '2026-10-21';
const jpeg = (n = 0) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, n]);
const entry = (over: Record<string, unknown> = {}) => ({
  loggedAt: T0,
  localDate: TODAY,
  pose: 'front',
  weightKg: 82.4,
  clientUpdatedAt: T0,
  ...over,
});

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const photo = (id: string, token = s.accessToken, bytes: Uint8Array = jpeg(), type = 'image/jpeg') =>
    t.request(`/v1/progress/${id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': type, ...authed(token) },
      body: bytes,
    });
  return { t, s, send, photo };
}

describe('progress entries', () => {
  it('stores details, then a photo, and serves it back to its owner only', async () => {
    const { t, send, photo } = await setup();
    const id = newId();
    const created = await body(await send('PUT', `/v1/progress/${id}`, entry({ note: 'week 4' })));
    expect(created.record).toMatchObject({
      id,
      pose: 'front',
      weightKg: 82.4,
      note: 'week 4',
      hasPhoto: false,
    });
    const up = await photo(id);
    expect(up.status).toBe(200);
    expect((await body(up)).hasPhoto).toBe(true);
    const got = await send('GET', `/v1/progress/${id}/photo`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([...jpeg()]);
    const other = await signUp(t);
    expect((await send('GET', `/v1/progress/${id}/photo`, undefined, other.accessToken)).status).toBe(404);
    expect((await photo(id, other.accessToken)).status).toBe(404);
  });
  it('keeps photos under the person’s own folder, so deleting the account removes them', async () => {
    const { s, send, photo } = await setup();
    const id = newId();
    await send('PUT', `/v1/progress/${id}`, entry());
    await photo(id);
    const row = await env.DB.prepare('SELECT photo_key FROM progress_photos WHERE id = ?')
      .bind(id)
      .first<{ photo_key: string }>();
    expect(row!.photo_key).toBe(`users/${s.userId}/progress/${id}.jpg`);
    expect((await send('DELETE', '/v1/account', { confirm: 'DELETE MY ACCOUNT' })).status).toBe(200);
    expect(await env.MEDIA.head(row!.photo_key)).toBeNull();
  });
  it('replaces a photo, removes it on request, and removes it with the entry', async () => {
    const { send, photo } = await setup();
    const id = newId();
    await send('PUT', `/v1/progress/${id}`, entry());
    await photo(id, undefined, jpeg(1));
    await photo(id, undefined, jpeg(2));
    expect([...new Uint8Array(await (await send('GET', `/v1/progress/${id}/photo`)).arrayBuffer())]).toEqual([
      ...jpeg(2),
    ]);
    expect((await send('DELETE', `/v1/progress/${id}/photo`)).status).toBe(204);
    expect((await send('DELETE', `/v1/progress/${id}/photo`)).status).toBe(204);
    expect((await send('GET', `/v1/progress/${id}/photo`)).status).toBe(404);
    expect((await body(await send('GET', `/v1/progress?from=${TODAY}&to=${TODAY}`))).items[0].hasPhoto).toBe(
      false,
    );

    await photo(id);
    const key = (await env.DB.prepare('SELECT photo_key FROM progress_photos WHERE id = ?')
      .bind(id)
      .first<{ photo_key: string }>())!.photo_key;
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect((await send('DELETE', `/v1/progress/${id}`)).status).toBe(204);
    expect(await env.MEDIA.head(key)).toBeNull();
  });
  it('refuses a photo for an entry that does not exist, is deleted, or is not an image', async () => {
    const { send, photo } = await setup();
    expect((await photo(newId())).status).toBe(404);
    const id = newId();
    await send('PUT', `/v1/progress/${id}`, entry());
    expect((await photo(id, undefined, new TextEncoder().encode('not an image'))).status).toBe(400);
    expect((await photo(id, undefined, jpeg(), 'text/plain')).status).toBe(400);
    await send('DELETE', `/v1/progress/${id}`);
    expect((await photo(id)).status).toBe(404);
  });
  it('validates entries', async () => {
    const { send } = await setup();
    for (const bad of [
      entry({ pose: 'upside-down' }),
      entry({ weightKg: 5 }),
      entry({ weightKg: 900 }),
      entry({ localDate: '2026-10-30' }),
      entry({ note: 'x'.repeat(501) }),
    ])
      expect((await send('PUT', `/v1/progress/${newId()}`, bad)).status).toBe(422);
    expect((await send('PUT', `/v1/progress/${newId()}`, entry({ weightKg: null }))).status).toBe(200);
  });
  it('lists a range oldest first', async () => {
    const { send } = await setup();
    await send('PUT', `/v1/progress/${newId()}`, entry({ pose: 'back', loggedAt: T0 + 1000 }));
    await send('PUT', `/v1/progress/${newId()}`, entry({ pose: 'front' }));
    const items = (await body(await send('GET', `/v1/progress?from=${TODAY}&to=${TODAY}`))).items;
    expect(items.map((i: any) => i.pose)).toEqual(['front', 'back']);
    expect((await send('GET', '/v1/progress?from=2015-01-01&to=2026-10-21')).status).toBe(422);
  });
  it('limits free accounts’ photos but not replacing one, and Pro is unlimited', async () => {
    const { s, send, photo } = await setup();
    await linkAccount(s.userId);
    const limit = PLANS.free.limits.progressPhotos;
    const ids: string[] = [];
    for (let i = 0; i < limit; i++) {
      ids.push(newId());
      await send('PUT', `/v1/progress/${ids[i]}`, entry({ loggedAt: T0 + i }));
      expect((await photo(ids[i]!)).status).toBe(200);
    }
    const extra = newId();
    await send('PUT', `/v1/progress/${extra}`, entry());
    const blocked = await photo(extra);
    expect(blocked.status).toBe(429);
    expect((await body(blocked)).error).toMatchObject({
      code: 'quota_exceeded',
      details: { key: 'progress_photos', limit },
    });
    expect((await photo(ids[0]!, undefined, jpeg(9))).status).toBe(200); // replacing is always allowed
    await send('POST', '/v1/subscription/simulate', { scenario: 'subscribe' });
    expect((await photo(extra)).status).toBe(200);
  });
  it('is last-edit-wins and keeps the photo through an edit', async () => {
    const { send, photo } = await setup();
    const id = newId();
    await send('PUT', `/v1/progress/${id}`, entry());
    await photo(id);
    const edited = await body(
      await send('PUT', `/v1/progress/${id}`, entry({ weightKg: 80, clientUpdatedAt: T0 + 100 })),
    );
    expect(edited.record).toMatchObject({ weightKg: 80, hasPhoto: true });
    expect(
      (await body(await send('PUT', `/v1/progress/${id}`, entry({ weightKg: 90, clientUpdatedAt: T0 + 1 }))))
        .applied,
    ).toBe(false);
  });
});
