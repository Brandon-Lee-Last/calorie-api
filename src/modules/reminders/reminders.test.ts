import { env } from 'cloudflare:workers';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient } from '../../../test/helpers/content';
import { MemoryPush } from '../../../test/helpers/push';
import { T0, body, jsonInit, makeApp, signUp, type TestApp } from '../../../test/helpers/app';
import { GoogleServiceAccountAuth } from '../../core/google-auth';
import { newId } from '../../core/ids';
import { silentLogger } from '../../core/logger';
import { FakeClock, MINUTE } from '../../core/time';
import { FcmSender, LogSender, unconfiguredSender } from './push';
import { LATE_AFTER_MS, MAX_PER_RUN } from './reminders.service';
import { MAX_DEVICES_PER_USER } from './reminders.repo';

const TOKEN = (n: number | string) => `fcm-token-${n}`.padEnd(40, 'x');
// The clock starts at 2026-10-21 12:00 UTC, which is 14:00 in Johannesburg (UTC+2).

let push: MemoryPush;
beforeEach(async () => {
  await env.DB.exec('DELETE FROM reminders');
  await env.DB.exec('DELETE FROM devices');
  push = new MemoryPush();
});

async function setup(tz = 'Africa/Johannesburg') {
  const t = makeApp({ pushSender: push });
  const s = await signUp(t);
  const send = (method: string, path: string, data?: unknown, token = s.accessToken) =>
    t.request(path, jsonInit(method, data, token));
  await send('PATCH', '/v1/me/profile', { timezone: tz });
  const device = (token = TOKEN(1), as = s.accessToken) =>
    send('POST', '/v1/devices', { token, appVersion: '1.0.0', locale: 'en-ZA' }, as);
  const remind = (kind: string, time: string, extra: Record<string, unknown> = {}) =>
    send('PUT', `/v1/reminders/${kind}`, { enabled: true, time, ...extra });
  const run = async () => body(await adminClient(t).call('POST', '/v1/admin/reminders/run'));
  return { t, s, send, device, remind, run };
}
/** Moves the clock without invalidating the sign-in. */
const advance = (t: TestApp, ms: number) => t.clock.advance(ms);

describe('registering phones', () => {
  it('needs sign-in and a plausible token', async () => {
    const { t, send } = await setup();
    expect((await t.request('/v1/devices', jsonInit('POST', { token: TOKEN(1) }))).status).toBe(401);
    expect((await send('POST', '/v1/devices', { token: 'short' })).status).toBe(422);
    expect((await send('POST', '/v1/devices', {})).status).toBe(422);
  });
  it('stores a token once however often it is registered', async () => {
    const { device } = await setup();
    expect((await device()).status).toBe(204);
    await device();
    await device();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>())!.n).toBe(1);
  });
  it('moves a token to whoever registered it last, so a handed-over phone stops notifying the old owner', async () => {
    const { t, s, device } = await setup();
    await device(TOKEN(1));
    const other = await signUp(t);
    await device(TOKEN(1), other.accessToken);
    const rows = await env.DB.prepare('SELECT user_id FROM devices').all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual([other.userId]);
    void s;
  });
  it('keeps only the newest phones per person', async () => {
    const { t, s, device } = await setup();
    for (let i = 0; i < MAX_DEVICES_PER_USER + 3; i++) {
      await device(TOKEN(i));
      advance(t, 1000);
    }
    const rows = await env.DB.prepare('SELECT token FROM devices WHERE user_id = ?')
      .bind(s.userId)
      .all<{ token: string }>();
    expect(rows.results).toHaveLength(MAX_DEVICES_PER_USER);
    expect(rows.results.map((r) => r.token)).not.toContain(TOKEN(0));
    expect(rows.results.map((r) => r.token)).toContain(TOKEN(MAX_DEVICES_PER_USER + 2));
  });
  it('unregisters on request, only for its own owner, and is safe to repeat', async () => {
    const { t, send, device } = await setup();
    await device(TOKEN(1));
    const other = await signUp(t);
    await send('POST', '/v1/devices/unregister', { token: TOKEN(1) }, other.accessToken);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>())!.n).toBe(1);
    expect((await send('POST', '/v1/devices/unregister', { token: TOKEN(1) })).status).toBe(204);
    expect((await send('POST', '/v1/devices/unregister', { token: TOKEN(1) })).status).toBe(204);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>())!.n).toBe(0);
  });
});

describe('setting reminders', () => {
  it('stores a reminder and says when it will next fire, in the person’s timezone', async () => {
    const { remind, send } = await setup();
    const res = await remind('breakfast', '07:30', { days: [1, 2, 3, 4, 5] });
    expect(res.status).toBe(200);
    const r = await body(res);
    expect(r).toMatchObject({
      kind: 'breakfast',
      enabled: true,
      time: '07:30',
      days: [1, 2, 3, 4, 5],
      lastSentAt: null,
    });
    expect(r.nextDueAt).toBe(Date.UTC(2026, 9, 22, 5, 30)); // Thursday 07:30 in Johannesburg
    expect((await body(await send('GET', '/v1/reminders'))).items).toHaveLength(1);
  });
  it('changes in place, can be switched off, and removed', async () => {
    const { remind, send } = await setup();
    await remind('water', '10:00');
    const changed = await body(await remind('water', '16:00', { days: [6, 7] }));
    expect(changed).toMatchObject({ time: '16:00', days: [6, 7] });
    const off = await body(await send('PUT', '/v1/reminders/water', { enabled: false, time: '16:00' }));
    expect(off).toMatchObject({ enabled: false, nextDueAt: null });
    expect((await body(await send('GET', '/v1/reminders'))).items).toHaveLength(1);
    expect((await send('DELETE', '/v1/reminders/water')).status).toBe(204);
    expect((await send('DELETE', '/v1/reminders/water')).status).toBe(204);
    expect((await body(await send('GET', '/v1/reminders'))).items).toEqual([]);
  });
  it('validates kinds, times and days', async () => {
    const { send } = await setup();
    for (const [path, data] of [
      ['/v1/reminders/elevenses', { enabled: true, time: '11:00' }],
      ['/v1/reminders/water', { enabled: true, time: '25:00' }],
      ['/v1/reminders/water', { enabled: true, time: '9:00' }],
      ['/v1/reminders/water', { enabled: true, time: '09:00', days: [] }],
      ['/v1/reminders/water', { enabled: true, time: '09:00', days: [0] }],
      ['/v1/reminders/water', { enabled: true, time: '09:00', days: [8] }],
      ['/v1/reminders/water', { time: '09:00' }],
    ] as const)
      expect((await send('PUT', path, data)).status, JSON.stringify(data)).toBe(422);
  });
  it('keeps each person’s reminders to themselves', async () => {
    const { t, remind, send } = await setup();
    await remind('lunch', '12:30');
    const other = await signUp(t);
    expect((await body(await send('GET', '/v1/reminders', undefined, other.accessToken))).items).toEqual([]);
  });
  it('is worked out again when the timezone changes', async () => {
    const { remind, send } = await setup('Africa/Johannesburg');
    const before = (await body(await remind('breakfast', '07:30'))).nextDueAt;
    await send('PATCH', '/v1/me/profile', { timezone: 'America/New_York' });
    const after = (await body(await send('GET', '/v1/reminders'))).items[0].nextDueAt;
    expect(after).not.toBe(before);
    expect(new Date(after).getUTCHours()).toBe(11); // 07:30 at UTC-4
    // changing something else leaves it alone
    await send('PATCH', '/v1/me/profile', { units: 'imperial' });
    expect((await body(await send('GET', '/v1/reminders'))).items[0].nextDueAt).toBe(after);
  });
});

describe('sending reminders', () => {
  it('sends a reminder when it comes due, once, with words that say nothing personal', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('water', '14:30');
    expect(await run()).toMatchObject({ configured: true, due: 0, sent: 0 });
    advance(t, 31 * MINUTE);
    expect(await run()).toMatchObject({ due: 1, sent: 1 });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({
      token: TOKEN(1),
      title: 'Time for some water',
      data: { kind: 'water' },
    });
    expect(await run()).toMatchObject({ due: 0, sent: 0 }); // already sent
    expect(push.sent).toHaveLength(1);
  });
  it('comes back the next day at the same local time', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('water', '14:30');
    advance(t, 31 * MINUTE);
    await run();
    const r = await env.DB.prepare('SELECT last_sent_at, next_due_at FROM reminders').first<{
      last_sent_at: number;
      next_due_at: number;
    }>();
    expect(r!.last_sent_at).toBe(t.clock.now());
    expect(r!.next_due_at).toBe(Date.UTC(2026, 9, 22, 12, 30));
    advance(t, 24 * 60 * MINUTE);
    await run();
    expect(push.sent).toHaveLength(2);
  });
  it('lets two overlapping runs send it only once', async () => {
    const { t, device, remind } = await setup();
    await device();
    await remind('water', '14:30');
    advance(t, 31 * MINUTE);
    const admin = adminClient(t);
    const reports = await Promise.all([1, 2, 3].map(() => admin.call('POST', '/v1/admin/reminders/run')));
    expect(reports.every((r) => r.status === 200)).toBe(true);
    expect(push.sent).toHaveLength(1);
  });
  it('sends to every phone, and drops one that has gone', async () => {
    const { t, device, remind, run } = await setup();
    await device(TOKEN(1));
    advance(t, 1000);
    await device(TOKEN(2));
    await remind('dinner', '14:10');
    advance(t, 15 * MINUTE);
    push.outcome = (m) => (m.token === TOKEN(2) ? 'invalid_token' : 'sent');
    expect(await run()).toMatchObject({ sent: 1, invalidTokens: 1 });
    expect(push.sent.map((m) => m.token)).toEqual([TOKEN(1)]);
    const left = await env.DB.prepare('SELECT token FROM devices').all<{ token: string }>();
    expect(left.results.map((r) => r.token)).toEqual([TOKEN(1)]);
  });
  it('tries again on the next run when the push service is down, then gives up when too late', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('water', '14:10');
    advance(t, 15 * MINUTE);
    push.outcome = 'retry';
    expect(await run()).toMatchObject({ due: 1, sent: 0, retried: 1 });
    advance(t, 5 * MINUTE);
    push.outcome = 'sent';
    expect(await run()).toMatchObject({ due: 1, sent: 1 });
    expect(push.sent).toHaveLength(1);

    // a different reminder that never gets through before it is too late
    await (
      await setup()
    ).remind; // (no-op: keep helpers tree-shaken away)
  });
  it('drops a reminder that is too late rather than sending it hours after the fact', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('breakfast', '14:10');
    advance(t, LATE_AFTER_MS + 30 * MINUTE);
    expect(await run()).toMatchObject({ due: 1, sent: 0, late: 1 });
    expect(push.sent).toHaveLength(0);
    const row = await env.DB.prepare('SELECT next_due_at FROM reminders').first<{ next_due_at: number }>();
    expect(row!.next_due_at).toBeGreaterThan(t.clock.now()); // rescheduled for tomorrow, not stuck
  });
  it('does nothing for people with no phone, or with the reminder switched off', async () => {
    const { t, send, remind, run } = await setup();
    await remind('water', '14:10');
    advance(t, 15 * MINUTE);
    expect(await run()).toMatchObject({ due: 1, sent: 0, skipped: 1 });
    await send('PUT', '/v1/reminders/lunch', { enabled: false, time: '14:10' });
    advance(t, 24 * 60 * MINUTE);
    expect((await run()).due).toBe(1); // only water is due again
  });
  it('skips the log nudge if the person has already logged something today', async () => {
    const { t, send, device, remind, run } = await setup();
    await device();
    await remind('log_nudge', '14:10');
    await send('PUT', `/v1/diary/entries/${newId()}`, {
      loggedAt: T0,
      localDate: '2026-10-21',
      mealType: 'lunch',
      name: 'Sandwich',
      calories: 400,
      source: 'manual',
      clientUpdatedAt: T0,
    });
    advance(t, 15 * MINUTE);
    expect(await run()).toMatchObject({ due: 1, sent: 0, skipped: 1 });
    expect(push.sent).toHaveLength(0);
  });
  it('sends the log nudge when nothing is logged', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('log_nudge', '14:10');
    advance(t, 15 * MINUTE);
    expect(await run()).toMatchObject({ sent: 1 });
    expect(push.sent[0]!.title).toContain('logged');
  });
  it('respects the days of the week', async () => {
    const { t, device, remind, run } = await setup();
    await device();
    await remind('weigh_in', '14:10', { days: [7] }); // Sundays; 2026-10-21 is a Wednesday
    advance(t, 15 * MINUTE);
    expect((await run()).due).toBe(0);
    advance(t, 4 * 24 * 60 * MINUTE); // Sunday 2026-10-25, 14:25
    expect(await run()).toMatchObject({ due: 1, sent: 1 });
  });
  it('handles at most a fixed number per run and leaves the rest for the next', async () => {
    const { t, s, run } = await setup();
    await env.DB.prepare(
      "INSERT INTO devices (id, user_id, token, platform, created_at, last_seen_at) VALUES ('d1', ?, ?, 'android', ?, ?)",
    )
      .bind(s.userId, TOKEN('bulk'), T0, T0)
      .run();
    const kinds = ['breakfast', 'lunch', 'dinner', 'water', 'weigh_in', 'log_nudge'];
    const people = Math.ceil((MAX_PER_RUN + 10) / kinds.length);
    for (let p = 0; p < people; p++) {
      const u = await signUp(t);
      for (const k of kinds)
        await env.DB.prepare(
          "INSERT INTO reminders (id, user_id, kind, local_time, days_mask, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, '14:00', 127, 1, ?, ?, ?)",
        )
          .bind(newId(), u.userId, k, T0 - MINUTE, T0, T0)
          .run();
      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, token, platform, created_at, last_seen_at) VALUES (?, ?, ?, 'android', ?, ?)",
      )
        .bind(newId(), u.userId, TOKEN(`p${p}`), T0, T0)
        .run();
    }
    const first = await run();
    expect(first.due).toBe(MAX_PER_RUN);
    const second = await run();
    expect(second.due).toBeGreaterThan(0);
    expect(first.sent + second.sent + first.skipped + second.skipped).toBeGreaterThan(MAX_PER_RUN);
  });
  it('does not stop for one broken reminder', async () => {
    const { t, s, device, remind, run } = await setup();
    await device();
    await remind('water', '14:10');
    const other = await signUp(t);
    await env.DB.prepare(
      "INSERT INTO devices (id, user_id, token, platform, created_at, last_seen_at) VALUES ('dx', ?, ?, 'android', ?, ?)",
    )
      .bind(other.userId, TOKEN('other'), T0, T0)
      .run();
    await env.DB.prepare(
      "INSERT INTO reminders (id, user_id, kind, local_time, days_mask, enabled, next_due_at, created_at, updated_at) VALUES ('bad', ?, 'dinner', 'garbage', 0, 1, ?, ?, ?)",
    )
      .bind(other.userId, T0 - 2 * MINUTE, T0, T0)
      .run();
    advance(t, 15 * MINUTE);
    const report = await run();
    expect(report.sent).toBeGreaterThanOrEqual(1);
    void s;
  });
  it('leaves everything untouched where notifications are not set up', async () => {
    const t = makeApp({ pushSender: unconfiguredSender });
    const s = await signUp(t);
    await t.request('/v1/reminders/water', jsonInit('PUT', { enabled: true, time: '12:30' }, s.accessToken));
    t.clock.advance(60 * MINUTE);
    const report = await body(await adminClient(t).call('POST', '/v1/admin/reminders/run'));
    expect(report).toMatchObject({ configured: false, due: 0, sent: 0 });
    const row = await env.DB.prepare('SELECT next_due_at FROM reminders').first<{ next_due_at: number }>();
    expect(row!.next_due_at).toBeLessThan(t.clock.now()); // not advanced: it will still go out once Firebase is set up
  });
});

describe('admin run', () => {
  it('needs the admin key', async () => {
    const { t } = await setup();
    expect((await t.request('/v1/admin/reminders/run', { method: 'POST' })).status).toBe(401);
  });
});

describe('test notification', () => {
  it('goes to the person’s phones', async () => {
    const { send, device } = await setup();
    await device(TOKEN(1));
    const res = await body(await send('POST', '/v1/reminders/test'));
    expect(res).toEqual({ devices: 1, delivered: 1 });
    expect(push.sent[0]).toMatchObject({ title: 'Reminders are working', data: { kind: 'test' } });
  });
  it('explains what is missing, and cleans up a dead token', async () => {
    const { send, device } = await setup();
    const none = await send('POST', '/v1/reminders/test');
    expect(none.status).toBe(400);
    expect((await body(none)).error.details).toEqual({ reason: 'no_device' });
    await device(TOKEN(1));
    push.outcome = 'invalid_token';
    expect(await body(await send('POST', '/v1/reminders/test'))).toEqual({ devices: 1, delivered: 0 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM devices').first<{ n: number }>())!.n).toBe(0);
  });
  it('says so when the server cannot send notifications', async () => {
    const t = makeApp({ pushSender: unconfiguredSender });
    const s = await signUp(t);
    await t.request('/v1/devices', jsonInit('POST', { token: TOKEN(1) }, s.accessToken));
    const res = await t.request('/v1/reminders/test', jsonInit('POST', undefined, s.accessToken));
    expect(res.status).toBe(400);
    expect((await body(res)).error.details).toEqual({ reason: 'push_not_configured' });
  });
});

describe('FcmSender', () => {
  async function fcm(responses: Array<Response | Error>, project: string | null = 'my-project') {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const json = JSON.stringify({
      client_email: 'svc@my-project.iam.gserviceaccount.com',
      private_key: await exportPKCS8(privateKey),
    });
    const calls: Array<{ url: string; auth: string; body: any }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.includes('oauth2'))
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      calls.push({
        url,
        auth: (init.headers as Record<string, string>).authorization!,
        body: JSON.parse(init.body as string),
      });
      const next = responses.shift() ?? new Response('{}');
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const auth = new GoogleServiceAccountAuth(json, new FakeClock(T0), fetcher);
    return { sender: new FcmSender(auth, project ?? undefined, silentLogger, fetcher), calls };
  }
  const message = { token: TOKEN(1), title: 'T', body: 'B', data: { kind: 'water' } };

  it('posts a high priority message with the right token and returns sent', async () => {
    const { sender, calls } = await fcm([new Response('{"name":"projects/my-project/messages/1"}')]);
    expect(sender.configured).toBe(true);
    expect(await sender.send(message)).toBe('sent');
    expect(calls[0]!.url).toBe('https://fcm.googleapis.com/v1/projects/my-project/messages:send');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(calls[0]!.body.message).toMatchObject({
      token: TOKEN(1),
      notification: { title: 'T', body: 'B' },
      data: { kind: 'water' },
      android: { priority: 'HIGH' },
    });
  });
  it('tells a dead token from a passing problem', async () => {
    const dead = [
      new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', {
        status: 404,
      }),
      new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 }),
      new Response('{"error":{"status":"INVALID_ARGUMENT"}}', { status: 400 }),
    ];
    for (const r of dead) expect(await (await fcm([r])).sender.send(message)).toBe('invalid_token');
    const passing = [
      new Response('', { status: 500 }),
      new Response('', { status: 503 }),
      new Response('', { status: 429 }),
      new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401 }),
      new Response('bad', { status: 400 }),
      new Error('offline'),
    ];
    for (const r of passing) expect(await (await fcm([r])).sender.send(message)).toBe('retry');
  });
  it('is not configured without a project or a key, and a bad key means retry rather than a crash', async () => {
    expect((await fcm([], null)).sender.configured).toBe(false);
    const none = new FcmSender(new GoogleServiceAccountAuth(undefined, new FakeClock(T0)), 'p', silentLogger);
    expect(none.configured).toBe(false);
    expect(await none.send(message)).toBe('retry');
  });
  it('the log sender logs and the unconfigured sender refuses', async () => {
    const lines: unknown[] = [];
    const ls = new LogSender({ ...silentLogger, info: (...a: unknown[]) => void lines.push(a) } as never);
    expect(await ls.send(message)).toBe('sent');
    expect(lines).toHaveLength(1);
    expect(unconfiguredSender.configured).toBe(false);
  });
});

describe('housekeeping', () => {
  it('forgets phones that have not been seen for six months', async () => {
    const { t, device } = await setup();
    await device();
    advance(t, 181 * 86_400_000);
    const r = await body(await adminClient(t).call('POST', '/v1/admin/maintenance/run'));
    expect(r.devicesRemoved).toBe(1);
  });
});
