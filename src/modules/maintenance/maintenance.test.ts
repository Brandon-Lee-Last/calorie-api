import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newId } from '../../core/ids';
import { DAY } from '../../core/time';
import { adminClient } from '../../../test/helpers/content';
import { T0, authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { TOMBSTONE_RETENTION_MS } from './maintenance.service';

const TODAY = '2026-10-21';

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  const water = (id = newId()) => ({
    id,
    body: { loggedAt: T0, localDate: TODAY, ml: 250, clientUpdatedAt: T0 },
  });
  const run = async () => body(await adminClient(t).call('POST', '/v1/admin/maintenance/run'));
  const relogin = async (refreshToken: string) =>
    (await body(await t.request('/v1/auth/refresh', jsonInit('POST', { refreshToken })))) as {
      accessToken: string;
      refreshToken: string;
    };
  return { t, s, send, water, run, relogin };
}

describe('nightly maintenance', () => {
  it('needs the admin key', async () => {
    const t = makeApp();
    expect((await t.request('/v1/admin/maintenance/run', { method: 'POST' })).status).toBe(401);
  });
  it('removes old sign-in tokens but keeps recent ones', async () => {
    const { t, s, run } = await setup();
    t.clock.advance(100 * DAY); // the first refresh token expired 10 days ago
    const fresh = await signUp(t); // a brand new, valid one
    const report = await run();
    expect(report.refreshTokensRemoved).toBe(1);
    const left = await env.DB.prepare('SELECT user_id FROM refresh_tokens WHERE user_id IN (?, ?)')
      .bind(s.userId, fresh.userId)
      .all<{ user_id: string }>();
    expect(left.results.map((r) => r.user_id)).toEqual([fresh.userId]);
  });
  it('removes revoked tokens after a month', async () => {
    const { t, s, send, run } = await setup();
    await send('POST', '/v1/auth/logout', { refreshToken: s.refreshToken });
    t.clock.advance(20 * DAY);
    expect((await run()).refreshTokensRemoved).toBe(0);
    t.clock.advance(11 * DAY);
    expect((await run()).refreshTokensRemoved).toBe(1);
  });
  it('removes finished rate-limit windows only', async () => {
    const { run } = await setup();
    await env.DB.exec('DELETE FROM rate_limits');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('old', ?, 9)").bind(
        T0 - 3 * DAY,
      ),
      env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('fresh', ?, 1)").bind(
        T0 - 1000,
      ),
    ]);
    expect((await run()).rateLimitsRemoved).toBe(1);
    expect(
      (await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>()).results.map((r) => r.key),
    ).toEqual(['fresh']);
  });
  it('removes old usage counters only', async () => {
    const { t, s, run } = await setup();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO usage_counters (user_id, key, period, count) VALUES (?, 'scan', '2026-10-10', 3)",
      ).bind(s.userId),
      env.DB.prepare(
        "INSERT INTO usage_counters (user_id, key, period, count) VALUES (?, 'scan', '2026-10-20', 2)",
      ).bind(s.userId),
    ]);
    expect((await run()).usageCountersRemoved).toBe(1);
    expect(
      (await env.DB.prepare('SELECT period FROM usage_counters').all<{ period: string }>()).results.map(
        (r) => r.period,
      ),
    ).toEqual(['2026-10-20']);
    void t;
  });

  it('removes old deletion markers, keeps newer ones and live records, and is repeatable', async () => {
    const { t, send, water, run } = await setup();
    const old = water();
    const keep = water();
    const recent = water();
    for (const w of [old, keep, recent]) await send('PUT', `/v1/water/${w.id}`, w.body);
    await send('DELETE', `/v1/water/${old.id}`);
    t.clock.advance(TOMBSTONE_RETENTION_MS + DAY); // `old` is now past retention
    await send('DELETE', `/v1/water/${recent.id}`); // a fresh deletion: kept for now
    const report = await run();
    expect(report.tombstonesRemoved.water_logs).toBe(1);
    const ids = (await env.DB.prepare('SELECT id FROM water_logs').all<{ id: string }>()).results
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([keep.id, recent.id].sort());
    expect((await run()).tombstonesRemoved.water_logs).toBe(0);
  });
  it('tells a device that missed the clean-up to start over, and only that device', async () => {
    const { t, s, send, water, run, relogin } = await setup();
    const first = water();
    const second = water();
    await send('PUT', `/v1/water/${first.id}`, first.body);
    await send('PUT', `/v1/water/${second.id}`, second.body);
    const synced = await body(await send('GET', '/v1/sync/pull')); // device A syncs now: rev 2
    expect(synced.rev).toBe(2);
    await send('DELETE', `/v1/water/${first.id}`); // rev 3: a deletion device A has not seen
    t.clock.advance(TOMBSTONE_RETENTION_MS + DAY);
    await run();
    const session = await relogin(s.refreshToken);

    const stale = await send('GET', `/v1/sync/pull?since=${synced.rev}`, undefined, session.accessToken);
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe('resync_required');

    const fromScratch = await body(
      await send('GET', '/v1/sync/pull?since=0', undefined, session.accessToken),
    );
    expect(fromScratch.changes.map((c: { record: { id: string } }) => c.record.id)).toEqual([second.id]);
    const upToDate = await send(
      'GET',
      `/v1/sync/pull?since=${fromScratch.rev}`,
      undefined,
      session.accessToken,
    );
    expect(upToDate.status).toBe(200);
  });
  it('works through a large backlog in batches', async () => {
    const { t, s, run } = await setup();
    const stamp = T0 - 40 * DAY;
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: newId(T0 + i), rev: i + 1 }));
    for (let i = 0; i < rows.length; i += 100) {
      await env.DB.batch(
        rows
          .slice(i, i + 100)
          .map((r) =>
            env.DB.prepare(
              'INSERT INTO water_logs (id, user_id, logged_at, local_date, ml, created_at, updated_at, deleted_at, client_updated_at, rev) VALUES (?, ?, ?, ?, 100, ?, ?, ?, ?, ?)',
            ).bind(r.id, s.userId, T0, TODAY, stamp, stamp, stamp, stamp, r.rev),
          ),
      );
    }
    expect((await run()).tombstonesRemoved.water_logs).toBe(1200);
    const purged = await env.DB.prepare('SELECT purged_rev FROM users WHERE id = ?')
      .bind(s.userId)
      .first<{ purged_rev: number }>();
    expect(purged!.purged_rev).toBe(1200);
    (void t, authed);
  });
});
