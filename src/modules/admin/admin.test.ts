import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminClient,
  exerciseBody,
  programBody,
  resetContent,
  seedLibrary,
  workout,
} from '../../../test/helpers/content';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';

beforeEach(resetContent);

const mp4 = (n = 100) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe('admin access', () => {
  it('needs the admin key', async () => {
    const t = makeApp();
    expect((await t.request('/v1/admin/programs')).status).toBe(401);
    expect((await t.request('/v1/admin/programs', { headers: { 'x-admin-key': 'wrong' } })).status).toBe(401);
    expect(
      (await t.request('/v1/admin/programs', { headers: { 'x-admin-key': env.ADMIN_API_KEY.slice(0, -1) } }))
        .status,
    ).toBe(401);
    expect(
      (await t.request('/v1/admin/programs', { headers: { 'x-admin-key': env.ADMIN_API_KEY } })).status,
    ).toBe(200);
  });
  it('is not opened by a normal user token', async () => {
    const t = makeApp();
    const s = await signUp(t);
    expect((await t.request('/v1/admin/programs', { headers: authed(s.accessToken) })).status).toBe(401);
  });
  it('is described in the OpenAPI document', async () => {
    const t = makeApp();
    const doc = await body(await t.request('/v1/openapi.json'));
    expect(doc.components.securitySchemes.adminKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-admin-key',
    });
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/admin/programs/{slug}',
        '/v1/sync/pull',
        '/v1/entitlements',
        '/v1/media/{id}/access',
      ]),
    );
  });
});

describe('admin media', () => {
  it('registers an external link, and insists on https', async () => {
    const { call } = adminClient(makeApp());
    const ok = await call('PUT', '/v1/admin/media/yt-squat', {
      kind: 'video',
      provider: 'external',
      location: 'https://videos.example.com/squat.mp4',
      tier: 'free',
    });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toMatchObject({
      key: 'yt-squat',
      provider: 'external',
      uploaded: true,
      tier: 'free',
    });
    for (const location of ['http://videos.example.com/x.mp4', 'not a url', undefined]) {
      expect(
        (
          await call('PUT', '/v1/admin/media/bad', {
            kind: 'video',
            provider: 'external',
            location,
            tier: 'free',
          })
        ).status,
      ).toBe(422);
    }
    expect(
      (await call('PUT', '/v1/admin/media/s1', { kind: 'video', provider: 'stream', tier: 'pro' })).status,
    ).toBe(422);
    expect(
      (await call('PUT', '/v1/admin/media/Bad Key', { kind: 'video', provider: 'r2', tier: 'free' })).status,
    ).toBe(422);
  });
  it('stores an uploaded file in R2 and removes it on delete', async () => {
    const { call, upload } = adminClient(makeApp());
    const created = await body(
      await call('PUT', '/v1/admin/media/squat-demo', {
        kind: 'video',
        provider: 'r2',
        tier: 'pro',
        title: 'Squat demo',
      }),
    );
    expect(created).toMatchObject({ provider: 'r2', uploaded: false, bytes: null });
    const res = await upload('squat-demo', mp4(500), 'video/mp4');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ uploaded: true, bytes: 500, mime: 'video/mp4', tier: 'pro' });
    expect((await env.MEDIA.head('media/squat-demo'))?.size).toBe(500);
    expect((await call('DELETE', '/v1/admin/media/squat-demo')).status).toBe(204);
    expect(await env.MEDIA.head('media/squat-demo')).toBeNull();
    expect((await call('DELETE', '/v1/admin/media/squat-demo')).status).toBe(204);
  });
  it('checks what is uploaded', async () => {
    const { call, upload } = adminClient(makeApp());
    await call('PUT', '/v1/admin/media/vid', { kind: 'video', provider: 'r2', tier: 'free' });
    await call('PUT', '/v1/admin/media/pic', { kind: 'image', provider: 'r2', tier: 'free' });
    await call('PUT', '/v1/admin/media/ext', {
      kind: 'video',
      provider: 'external',
      location: 'https://x.example.com/v.mp4',
      tier: 'free',
    });
    expect((await upload('vid', mp4(), 'application/zip')).status).toBe(400);
    expect((await upload('vid', mp4(), 'image/jpeg')).status).toBe(400); // an image for a video entry
    expect((await upload('vid', new Uint8Array(0), 'video/mp4')).status).toBe(400);
    expect((await upload('pic', new TextEncoder().encode('<html>'), 'image/jpeg')).status).toBe(400);
    expect((await upload('pic', jpeg, 'image/jpeg')).status).toBe(200);
    expect((await upload('ext', mp4(), 'video/mp4')).status).toBe(400);
    expect((await upload('nope', mp4(), 'video/mp4')).status).toBe(404);
  });
  it('keeps the id (and the upload) when the entry is edited', async () => {
    const { call, upload } = adminClient(makeApp());
    const a = await body(
      await call('PUT', '/v1/admin/media/keep', { kind: 'video', provider: 'r2', tier: 'free' }),
    );
    await upload('keep', mp4(10), 'video/mp4');
    const b = await body(
      await call('PUT', '/v1/admin/media/keep', {
        kind: 'video',
        provider: 'r2',
        tier: 'pro',
        title: 'New title',
      }),
    );
    expect(b).toMatchObject({ id: a.id, tier: 'pro', title: 'New title', bytes: 10, uploaded: true });
  });
});

describe('admin exercises and programs', () => {
  it('rejects exercises that point at media which does not exist, and unknown muscles', async () => {
    const { call } = adminClient(makeApp());
    const res = await call('PUT', '/v1/admin/exercises/lunge', exerciseBody({ videoMediaKey: 'missing' }));
    expect(res.status).toBe(422);
    expect((await body(res)).error.details[0].path).toBe('videoMediaKey');
    expect(
      (await call('PUT', '/v1/admin/exercises/lunge', exerciseBody({ muscleGroups: ['wings'] }))).status,
    ).toBe(422);
    expect((await call('PUT', '/v1/admin/exercises/lunge', exerciseBody({ muscleGroups: [] }))).status).toBe(
      422,
    );
    expect((await call('PUT', '/v1/admin/exercises/Not A Slug', exerciseBody())).status).toBe(422);
  });
  it('lists an exercise with its media once those exist', async () => {
    const t = makeApp();
    const { call } = adminClient(t);
    const media = await body(
      await call('PUT', '/v1/admin/media/lunge-video', {
        kind: 'video',
        provider: 'external',
        location: 'https://x.example.com/l.mp4',
        tier: 'free',
      }),
    );
    await call(
      'PUT',
      '/v1/admin/exercises/lunge',
      exerciseBody({ name: 'Walking Lunge', videoMediaKey: 'lunge-video' }),
    );
    const s = await signUp(t);
    const ex = await body(await t.request('/v1/exercises/lunge', { headers: authed(s.accessToken) }));
    expect(ex).toMatchObject({
      slug: 'lunge',
      name: 'Walking Lunge',
      videoMediaId: media.id,
      imageMediaId: null,
      source: 'Our own content',
    });
  });
  it('validates a program tree and names every problem', async () => {
    const { call } = adminClient(makeApp());
    await call('PUT', '/v1/admin/exercises/plank', exerciseBody({ name: 'Plank', muscleGroups: ['abs'] }));
    const bad = async (workouts: unknown[], over: Record<string, unknown> = {}) =>
      call('PUT', '/v1/admin/programs/p', programBody(workouts, over));
    expect((await bad([])).status).toBe(422);
    expect((await bad([workout('a', 1, 1, ['plank']), workout('a', 1, 2, ['plank'])])).status).toBe(422); // duplicate key
    expect((await bad([workout('a', 1, 1, ['plank']), workout('b', 1, 1, ['plank'])])).status).toBe(422); // same slot
    expect((await bad([workout('a', 9, 1, ['plank'])], { weeks: 4 })).status).toBe(422); // beyond the program
    const unknown = await bad([workout('a', 1, 1, ['plank', 'levitation'])]);
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(await body(unknown))).toContain('levitation');
    expect((await bad([workout('a', 1, 1, [], {})])).status).toBe(422); // no exercises
    const noReps = { key: 'a', week: 1, day: 1, title: 'x', exercises: [{ exerciseSlug: 'plank', sets: 3 }] };
    expect((await bad([noReps])).status).toBe(422);
    const backwards = { ...noReps, exercises: [{ exerciseSlug: 'plank', sets: 3, repsMin: 12, repsMax: 8 }] };
    expect((await bad([backwards])).status).toBe(422);
    expect((await body(await call('GET', '/v1/admin/programs'))).items).toEqual([]); // nothing was half-saved
  });
  it('keeps a program as a draft until published, and unpublishing hides it', async () => {
    const t = makeApp();
    const { call } = adminClient(t);
    await call('PUT', '/v1/admin/exercises/plank', exerciseBody({ name: 'Plank', muscleGroups: ['abs'] }));
    const put = await call('PUT', '/v1/admin/programs/core', programBody([workout('a', 1, 1, ['plank'])]));
    expect(await body(put)).toMatchObject({ slug: 'core', published: false, workouts: 1 });
    const s = await signUp(t);
    const visible = async () =>
      (await body(await t.request('/v1/programs', { headers: authed(s.accessToken) }))).items.map(
        (p: { slug: string }) => p.slug,
      );
    expect(await visible()).toEqual([]);
    expect((await t.request('/v1/programs/core', { headers: authed(s.accessToken) })).status).toBe(404);
    expect((await call('POST', '/v1/admin/programs/core/publish')).status).toBe(200);
    expect(await visible()).toEqual(['core']);
    expect((await call('POST', '/v1/admin/programs/core/unpublish')).status).toBe(200);
    expect(await visible()).toEqual([]);
    expect((await call('POST', '/v1/admin/programs/nope/publish')).status).toBe(404);
    expect((await call('POST', '/v1/admin/programs/nope/unpublish')).status).toBe(404);
  });
  it('re-importing keeps workout ids, drops removed workouts and stays published', async () => {
    const t = makeApp();
    const { admin } = await seedLibrary(t);
    const s = await signUp(t);
    const outline = async () => {
      const p = await body(
        await t.request('/v1/programs/beginner-strength', { headers: authed(s.accessToken) }),
      );
      return Object.fromEntries(
        p.schedule.flatMap((w: any) => w.days.flatMap((d: any) => d.workouts.map((x: any) => [x.key, x]))),
      );
    };
    const before = await outline();
    expect(Object.keys(before).sort()).toEqual(['w1d1', 'w1d2', 'w2d1']);
    const again = await admin.call(
      'PUT',
      '/v1/admin/programs/beginner-strength',
      programBody([
        workout('w1d1', 1, 1, ['plank'], { title: 'Renamed' }),
        workout('w3d1', 3, 1, ['bench-press']),
      ]),
    ); // fmt: skip
    expect(await body(again)).toMatchObject({ published: true, workouts: 2 });
    const after = await outline();
    expect(Object.keys(after).sort()).toEqual(['w1d1', 'w3d1']);
    expect(after.w1d1.id).toBe(before.w1d1.id);
    expect(after.w1d1.title).toBe('Renamed');
    expect(after.w1d1.exerciseCount).toBe(1);
  });
  it('writes a large program in one go', async () => {
    const t = makeApp();
    const { call } = adminClient(t);
    const slugs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const slug = `move-${i}`;
      slugs.push(slug);
      await call('PUT', `/v1/admin/exercises/${slug}`, exerciseBody({ name: `Move ${i}` }));
    }
    const workouts = [];
    for (let w = 1; w <= 12; w++)
      for (let d = 1; d <= 4; d++) workouts.push(workout(`w${w}d${d}`, w, d, slugs));
    const res = await call(
      'PUT',
      '/v1/admin/programs/big',
      programBody(workouts, { weeks: 12, daysPerWeek: 4 }),
    );
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM workout_exercises x JOIN workouts w ON w.id = x.workout_id JOIN programs p ON p.id = w.program_id WHERE p.slug = ?',
    )
      .bind('big')
      .first<{ n: number }>();
    expect(rows!.n).toBe(48 * 8);
    expect((await call('POST', '/v1/admin/programs/big/publish')).status).toBe(200);
  });
  it('deletes a program, and an exercise only when nothing uses it', async () => {
    const t = makeApp();
    const { admin } = await seedLibrary(t);
    expect((await admin.call('DELETE', '/v1/admin/exercises/plank')).status).toBe(409);
    expect((await admin.call('DELETE', '/v1/admin/programs/beginner-strength')).status).toBe(204);
    expect((await admin.call('DELETE', '/v1/admin/programs/beginner-strength')).status).toBe(204);
    expect((await admin.call('DELETE', '/v1/admin/exercises/plank')).status).toBe(204);
    const list = await body(await admin.call('GET', '/v1/admin/programs'));
    expect(list.items.map((p: { slug: string }) => p.slug)).toEqual(['mass-builder']);
  });
});

describe('model accuracy report', () => {
  it('summarises what people kept against what the model said, ignoring portion choices', async () => {
    const t = makeApp();
    const { call } = adminClient(t);
    const s = await signUp(t);
    const put = (over: Record<string, unknown>) =>
      t.request(
        `/v1/scans/${newId()}`,
        jsonInit(
          'PUT',
          { modelVersion: 'nutrition_v1', contributeConsent: false, clientCreatedAt: T0, ...over },
          s.accessToken,
        ),
      );
    const pred = (calories: number) => ({ calories, massG: 100, fatG: 1, carbG: 1, proteinG: 1 });
    await put({ outcome: 'saved', predicted: pred(400), final: pred(400), portion: 1 }); // no correction
    await put({ outcome: 'saved', predicted: pred(400), final: pred(600), portion: 1.5 }); // portion only: no correction
    await put({ outcome: 'edited', predicted: pred(400), final: pred(300), portion: 1 }); // lowered by 100
    await put({ outcome: 'edited', predicted: pred(500), final: pred(560), portion: 1 }); // raised by 60
    await put({ outcome: 'not_food', foodProbability: 0.01 });
    await put({ outcome: 'discarded', predicted: pred(250) });
    await put({ modelVersion: 'nutrition_v0', outcome: 'saved', predicted: pred(100), final: pred(100) });
    const report = await body(await call('GET', '/v1/admin/scans/accuracy?modelVersion=nutrition_v1'));
    expect(report.models).toEqual([
      {
        modelVersion: 'nutrition_v1',
        scans: 6,
        notFood: 1,
        discarded: 1,
        kept: 4,
        editedShare: 0.5,
        meanCorrectionKcal: 40,
        meanSignedCorrectionKcal: -10,
        contributedPhotos: 0,
      },
    ]); // fmt: skip
    const all = await body(await call('GET', '/v1/admin/scans/accuracy'));
    expect(all.models.map((m: { modelVersion: string }) => m.modelVersion)).toEqual([
      'nutrition_v0',
      'nutrition_v1',
    ]);
  });
});
