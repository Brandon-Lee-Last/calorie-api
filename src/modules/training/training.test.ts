import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';
import { MINUTE } from '../../core/time';

const jpeg = (n = 0) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, n]);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM scan_events');
  await env.DB.exec('DELETE FROM admin_audit');
});

async function setup() {
  const t = makeApp();
  const admin = adminClient(t);
  const people = [await signUp(t), await signUp(t)];
  const contribute = async (
    who: number,
    over: Record<string, unknown> = {},
    opts: { consent?: boolean; photo?: boolean; advance?: number } = {},
  ) => {
    const s = people[who]!;
    const id = newId();
    const consent = opts.consent ?? true;
    await t.request(
      `/v1/scans/${id}`,
      jsonInit(
        'PUT',
        {
          modelVersion: 'nutrition_v1',
          foodProbability: 0.95,
          predicted: { calories: 400, massG: 200, fatG: 10, carbG: 40, proteinG: 20 },
          outcome: 'edited',
          final: { calories: 520, massG: 260, fatG: 20, carbG: 50, proteinG: 25 },
          portion: 1,
          contributeConsent: consent,
          clientCreatedAt: T0,
          ...over,
        },
        s.accessToken,
      ),
    );
    if (consent && opts.photo !== false)
      await t.request(`/v1/scans/${id}/photo`, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
        body: jpeg(),
      });
    t.clock.advance(opts.advance ?? 1000);
    return id;
  };
  const list = async (query = '') =>
    body(await admin.call('GET', `/v1/admin/training/contributions${query}`));
  return { t, admin, people, contribute, list };
}

describe('GET /admin/training/contributions', () => {
  it('needs the admin key', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/admin/training/contributions')).status).toBe(401);
    expect((await t.request('/v1/admin/training/contributions/abc12345/photo')).status).toBe(401);
  });
  it('lists only photos whose owner agreed, oldest first, with no user id anywhere', async () => {
    const { people, contribute, list } = await setup();
    const a = await contribute(0);
    await contribute(0, {}, { consent: false });
    await contribute(1, {}, { photo: false }); // consent given but no photo uploaded
    const b = await contribute(1, {
      outcome: 'saved',
      final: { calories: 400, massG: 200, fatG: 10, carbG: 40, proteinG: 20 },
    });
    const page = await list();
    expect(page.items.map((i: any) => i.id)).toEqual([a, b]);
    const text = JSON.stringify(page);
    for (const p of people) expect(text).not.toContain(p.userId);
    expect(text).not.toContain('contrib/');
    expect(page.items[0]).toMatchObject({
      kind: 'food',
      outcome: 'edited',
      modelVersion: 'nutrition_v1',
      predictedCalories: 400,
      label: { calories: 520, massG: 260, fatG: 20, carbG: 50, proteinG: 25, edited: true },
      photoType: 'image/jpeg',
    });
    expect(page.items[1].label.edited).toBe(false);
  });
  it('gives one person’s photos the same donor code and different people different ones', async () => {
    const { contribute, list } = await setup();
    await contribute(0);
    await contribute(0);
    await contribute(1);
    const donors = (await list()).items.map((i: any) => i.donor);
    expect(donors[0]).toBe(donors[1]);
    expect(donors[2]).not.toBe(donors[0]);
    expect(donors[0]).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
  it('labels not-food answers and discards, and never invents numbers for them', async () => {
    const { contribute, list } = await setup();
    await contribute(0, { outcome: 'not_food', predicted: null, final: null });
    await contribute(0, { outcome: 'discarded', final: null });
    const items = (await list()).items;
    expect(items.map((i: any) => [i.kind, i.label])).toEqual([
      ['not_food', null],
      ['unlabelled', null],
    ]);
  });
  it('treats a zero or missing weight as unknown rather than as a measurement', async () => {
    const { contribute, list } = await setup();
    await contribute(0, { final: { calories: 300, massG: 0, fatG: 5, carbG: 30, proteinG: 10 } });
    const label = (await list()).items[0].label;
    expect(label.massG).toBeNull();
    expect(label.calories).toBe(300);
  });
  it('pages in order without skipping or repeating, even when photos share a timestamp', async () => {
    const { contribute, list } = await setup();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await contribute(i % 2, {}, { advance: i === 2 ? 0 : 1000 })); // 2 and 3 arrive in the same millisecond
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((i: any) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });
  it('can start from a point in time, to fetch only what is new', async () => {
    const { t, contribute, list } = await setup();
    await contribute(0, {}, { advance: 5 * MINUTE });
    const cut = t.clock.now();
    const fresh = await contribute(1);
    expect((await list(`?since=${cut}`)).items.map((i: any) => i.id)).toEqual([fresh]);
  });
  it('stops listing a photo the moment the person takes consent back', async () => {
    const { t, people, contribute, list } = await setup();
    const id = await contribute(0);
    expect((await list()).items).toHaveLength(1);
    await t.request(
      `/v1/scans/${id}`,
      jsonInit(
        'PUT',
        { modelVersion: 'nutrition_v1', outcome: 'saved', contributeConsent: false, clientCreatedAt: T0 },
        people[0]!.accessToken,
      ),
    );
    expect((await list()).items).toHaveLength(0);
  });
  it('rejects a bad cursor', async () => {
    const { admin } = await setup();
    expect((await admin.call('GET', '/v1/admin/training/contributions?cursor=garbage')).status).toBe(400);
  });
});

describe('GET /admin/training/contributions/{id}/photo', () => {
  it('returns the bytes as a download', async () => {
    const { admin, contribute } = await setup();
    const id = await contribute(0);
    const res = await admin.call('GET', `/v1/admin/training/contributions/${id}/photo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...jpeg()]);
  });
  it('is gone once consent is withdrawn, and for scans that never had a photo', async () => {
    const { t, admin, people, contribute } = await setup();
    const id = await contribute(0);
    const none = await contribute(1, {}, { consent: false });
    await t.request(
      `/v1/scans/${id}`,
      jsonInit(
        'PUT',
        { modelVersion: 'nutrition_v1', outcome: 'saved', contributeConsent: false, clientCreatedAt: T0 },
        people[0]!.accessToken,
      ),
    );
    expect((await admin.call('GET', `/v1/admin/training/contributions/${id}/photo`)).status).toBe(404);
    expect((await admin.call('GET', `/v1/admin/training/contributions/${none}/photo`)).status).toBe(404);
    expect((await admin.call('GET', '/v1/admin/training/contributions/does-not-exist/photo')).status).toBe(
      404,
    );
  });
  it('404s if the file itself has gone missing', async () => {
    const { admin, contribute } = await setup();
    const id = await contribute(0);
    const row = await env.DB.prepare('SELECT image_key FROM scan_events WHERE id = ?')
      .bind(id)
      .first<{ image_key: string }>();
    await env.MEDIA.delete(row!.image_key);
    expect((await admin.call('GET', `/v1/admin/training/contributions/${id}/photo`)).status).toBe(404);
  });
  it('is recorded in the admin audit log', async () => {
    const { admin, contribute } = await setup();
    const id = await contribute(0);
    await admin.call('GET', `/v1/admin/training/contributions/${id}/photo`);
    const audit = await body(await admin.call('GET', '/v1/admin/audit?limit=5'));
    expect(audit.items.map((i: any) => i.path)).toContain(`/v1/admin/training/contributions/${id}/photo`);
  });
});

describe('contributed photos are cleaned on the way in', () => {
  it('keeps no position or device details in storage', async () => {
    const { t, people } = await setup();
    const id = newId();
    const s = people[0]!;
    await t.request(
      `/v1/scans/${id}`,
      jsonInit(
        'PUT',
        {
          modelVersion: 'nutrition_v1',
          outcome: 'saved',
          final: { calories: 1, massG: 1, fatG: 1, carbG: 1, proteinG: 1 },
          contributeConsent: true,
          clientCreatedAt: T0,
        },
        s.accessToken,
      ),
    );
    const ascii = (x: string) => [...x].map((c) => c.charCodeAt(0));
    const exifPayload = [
      ...ascii('Exif\0\0'),
      0x49,
      0x49,
      0x2a,
      0,
      8,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...ascii('GPS-33.9249S-18.4241E-serial-ABC123'),
    ];
    const len = exifPayload.length + 2;
    const photo = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      len >> 8,
      len & 255,
      ...exifPayload,
      0xff,
      0xda,
      0,
      4,
      1,
      2,
      3,
      4,
      0xff,
      0xd9,
    ]);
    const up = await t.request(`/v1/scans/${id}/photo`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', ...authed(s.accessToken) },
      body: photo,
    });
    expect(up.status).toBe(200);
    const row = await env.DB.prepare('SELECT image_key FROM scan_events WHERE id = ?')
      .bind(id)
      .first<{ image_key: string }>();
    const stored = new Uint8Array(await (await env.MEDIA.get(row!.image_key))!.arrayBuffer());
    const text = String.fromCharCode(...stored);
    expect(text).not.toContain('GPS');
    expect(text).not.toContain('ABC123');
    expect(stored.length).toBeLessThan(photo.length);
    expect([...stored.slice(-10)]).toEqual([0xff, 0xda, 0, 4, 1, 2, 3, 4, 0xff, 0xd9]);
  });
});
