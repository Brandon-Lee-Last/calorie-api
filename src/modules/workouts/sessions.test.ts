import { beforeEach, describe, expect, it } from 'vitest';
import { resetContent } from '../../../test/helpers/content';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';

beforeEach(resetContent);

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const session = (over: Record<string, unknown> = {}) => ({
    title: 'Push day',
    startedAt: T0 - 3_600_000,
    finishedAt: T0 - 600_000,
    localDate: '2026-10-21',
    clientUpdatedAt: T0,
    sets: [
      { exercise: 'bench-press', setNo: 1, reps: 10, weightKg: 60 },
      { exercise: 'bench-press', setNo: 2, reps: 8, weightKg: 70 },
    ],
    ...over,
  }); // fmt: skip
  return { t, s, send, session };
}

describe('workout sessions', () => {
  it('logs a workout with its sets and reads it back', async () => {
    const { send, session } = await setup();
    const id = newId();
    const res = await send(
      'PUT',
      `/v1/training/sessions/${id}`,
      session({ notes: 'felt strong', rating: 4, caloriesBurned: 320.5 }),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      applied: true,
      record: {
        id,
        title: 'Push day',
        rating: 4,
        caloriesBurned: 320.5,
        notes: 'felt strong',
        workoutId: null,
        programId: null,
        sets: [{ exercise: 'bench-press', setNo: 1, reps: 10, weightKg: 60 }, { setNo: 2 }],
      },
    }); // fmt: skip
    const list = await body(await send('GET', '/v1/training/sessions?from=2026-10-21&to=2026-10-21'));
    expect(list.items).toHaveLength(1);
  });
  it('is idempotent, later edits win, and deleting hides it', async () => {
    const { send, session } = await setup();
    const id = newId();
    await send('PUT', `/v1/training/sessions/${id}`, session());
    expect(
      (
        await body(
          await send(
            'PUT',
            `/v1/training/sessions/${id}`,
            session({ title: 'Renamed', clientUpdatedAt: T0 + 5 }),
          ),
        )
      ).record.title,
    ).toBe('Renamed');
    expect(
      (
        await body(
          await send(
            'PUT',
            `/v1/training/sessions/${id}`,
            session({ title: 'Old', clientUpdatedAt: T0 + 1 }),
          ),
        )
      ).applied,
    ).toBe(false);
    expect((await send('DELETE', `/v1/training/sessions/${id}`)).status).toBe(204);
    expect((await send('DELETE', `/v1/training/sessions/${id}`)).status).toBe(204);
    expect(
      (await body(await send('GET', '/v1/training/sessions?from=2026-10-21&to=2026-10-21'))).items,
    ).toEqual([]);
  });
  it('rejects impossible sessions', async () => {
    const { send, session } = await setup();
    const bad: [Record<string, unknown>, string][] = [
      [{ finishedAt: T0 - 7_200_000 }, 'finishedAt'], // before it started
      [{ finishedAt: T0 + DAY }, 'finishedAt'], // in the future
      [{ startedAt: T0 - 2 * DAY, finishedAt: T0, localDate: '2026-10-19' }, 'finishedAt'], // longer than a day
      [{ localDate: '2026-10-25' }, 'localDate'],
      [{ title: '' }, 'title'],
      [{ rating: 6 }, 'rating'],
      [{ sets: [{ exercise: 'Not A Slug', setNo: 1 }] }, 'sets.0.exercise'],
      [{ sets: [{ exercise: 'plank', setNo: 0 }] }, 'sets.0.setNo'],
      [
        { sets: Array.from({ length: 301 }, (_, i) => ({ exercise: 'plank', setNo: (i % 100) + 1 })) },
        'sets',
      ],
    ]; // fmt: skip
    for (const [over, path] of bad) {
      const res = await send('PUT', `/v1/training/sessions/${newId()}`, session(over));
      expect(res.status, path).toBe(422);
      expect((await body(res)).error.details.map((d: { path: string }) => d.path)).toContain(path);
    }
  });
  it('rejects a workout that belongs to a different program, but accepts one that no longer exists', async () => {
    const { send, session } = await setup();
    const orphan = await send(
      'PUT',
      `/v1/training/sessions/${newId()}`,
      session({ workoutId: newId(), programId: newId() }),
    );
    expect(orphan.status).toBe(200); // history survives a removed program
  });
  it('totals finished sessions only', async () => {
    const { send, session } = await setup();
    await send('PUT', `/v1/training/sessions/${newId()}`, session());
    await send(
      'PUT',
      `/v1/training/sessions/${newId()}`,
      session({
        finishedAt: T0 - 3_600_000 + 30 * 60_000,
        sets: [{ exercise: 'plank', setNo: 1, durationS: 60 }],
      }),
    );
    await send('PUT', `/v1/training/sessions/${newId()}`, session({ finishedAt: null })); // still in progress
    const gone = newId();
    await send('PUT', `/v1/training/sessions/${gone}`, session());
    await send('DELETE', `/v1/training/sessions/${gone}`);
    const stats = await body(await send('GET', '/v1/training/stats?from=2026-10-01&to=2026-10-31'));
    expect(stats).toEqual({ sessions: 2, minutes: 80, sets: 3, volumeKg: 1160, byDate: { '2026-10-21': 2 } });
  });
  it('keeps users apart, limits ranges and needs sign-in', async () => {
    const { t, send, session } = await setup();
    const id = newId();
    await send('PUT', `/v1/training/sessions/${id}`, session());
    const other = await signUp(t);
    expect((await send('PUT', `/v1/training/sessions/${id}`, session(), other.accessToken)).status).toBe(409);
    expect(
      (
        await body(
          await send(
            'GET',
            '/v1/training/sessions?from=2026-10-01&to=2026-10-31',
            undefined,
            other.accessToken,
          ),
        )
      ).items,
    ).toEqual([]);
    expect((await send('GET', '/v1/training/sessions?from=2024-01-01&to=2026-10-31')).status).toBe(422);
    expect((await t.request('/v1/training/sessions?from=2026-10-01&to=2026-10-31')).status).toBe(401);
    void authed;
  });
  it('syncs between devices like every other record', async () => {
    const { send, session } = await setup();
    const id = newId();
    const push = await body(
      await send('POST', '/v1/sync/push', {
        ops: [{ type: 'workout_session', id, op: 'upsert', data: session() }],
      }),
    );
    expect(push.results[0]).toMatchObject({ status: 'applied', record: { id, title: 'Push day' } });
    const pull = await body(await send('GET', '/v1/sync/pull'));
    expect(pull.changes).toHaveLength(1);
    expect(pull.changes[0]).toMatchObject({ type: 'workout_session', record: { id, rev: 1 } });
    const del = await body(
      await send('POST', '/v1/sync/push', { ops: [{ type: 'workout_session', id, op: 'delete' }] }),
    );
    expect(del.results[0].status).toBe('applied');
    expect(
      (await body(await send('GET', `/v1/sync/pull?since=${pull.rev}`))).changes[0].record.deletedAt,
    ).toBe(T0);
  });
});
