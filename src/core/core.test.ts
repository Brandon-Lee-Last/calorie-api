import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  fromBase64Url,
  hmacSha256Base64Url,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  toBase64Url,
  toHex,
} from './crypto';
import { AppError, isAppError, notFound, rateLimited } from './errors';
import { isClientId, isId, newId } from './ids';
import { createLogger, redact } from './logger';
import { decodeCursor, encodeCursor, pageQuerySchema, toPage } from './pagination';
import { D1RateLimiter, MemoryRateLimiter, unlimited } from './rate-limiter';
import { FakeClock, addDays, dateRange, isLocalDate, isTimeZone, localDateIn } from './time';

describe('ids', () => {
  it('makes 26-character Crockford ids that sort by time', () => {
    const a = newId(1_000_000_000_000);
    const b = newId(1_000_000_000_001);
    expect(a).toHaveLength(26);
    expect(isId(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
  it('is random in the tail', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId(5)));
    expect(ids.size).toBe(200);
  });
  it('encodes the timestamp the way ULID does', () => {
    expect(newId(0, () => new Uint8Array(10)).slice(0, 10)).toBe('0000000000');
    expect(newId(32, () => new Uint8Array(10)).slice(0, 10)).toBe('0000000010');
  });
  it('validates ids and accepts UUIDs for client-made records', () => {
    expect(isId('nope')).toBe(false);
    expect(isId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isId('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // contains I
    expect(isClientId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isClientId('123e4567-e89b-12d3-a456')).toBe(false);
    expect(isClientId(42)).toBe(false);
  });
});

describe('crypto', () => {
  it('hex and base64url round trip', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(toHex(bytes)).toBe('0001fafbfcfdfeff');
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });
  it('sha256 matches the known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('hmac is deterministic and key dependent', async () => {
    const a = await hmacSha256Base64Url('k1', 'msg');
    expect(a).toBe(await hmacSha256Base64Url('k1', 'msg'));
    expect(a).not.toBe(await hmacSha256Base64Url('k2', 'msg'));
    expect(a).not.toBe(await hmacSha256Base64Url('k1', 'msg2'));
  });
  it('random tokens are long and unique', () => {
    const a = randomToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(randomToken());
  });
  it('timingSafeEqual compares correctly, including different lengths', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('time', () => {
  it('validates real calendar dates only', () => {
    expect(isLocalDate('2026-02-28')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-1')).toBe(false);
    expect(isLocalDate(20260101)).toBe(false);
  });
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-15', 0)).toBe('2026-01-15');
  });
  it('turns an instant into the local date of a timezone', () => {
    const t = Date.UTC(2026, 0, 1, 23, 30); // 23:30 UTC on 1 Jan
    expect(localDateIn('UTC', t)).toBe('2026-01-01');
    expect(localDateIn('Africa/Johannesburg', t)).toBe('2026-01-02'); // UTC+2
    expect(localDateIn('America/Los_Angeles', t)).toBe('2026-01-01');
  });
  it('checks timezones', () => {
    expect(isTimeZone('Africa/Johannesburg')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(5)).toBe(false);
  });
  it('lists an inclusive range', () => {
    expect(dateRange('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(dateRange('2026-03-02', '2026-03-01')).toEqual([]);
  });
  it('the fake clock moves when told to', () => {
    const c = new FakeClock(10);
    c.advance(5);
    expect(c.now()).toBe(15);
    c.set(1);
    expect(c.now()).toBe(1);
  });
});

describe('errors', () => {
  it('carries status, code and details', () => {
    const e = notFound('Meal');
    expect(isAppError(e)).toBe(true);
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'Meal not found' });
    expect(rateLimited(7)).toMatchObject({ status: 429, details: { retryAfterSeconds: 7 } });
    expect(isAppError(new Error('x'))).toBe(false);
    expect(new AppError(400, 'bad_request', 'x')).toBeInstanceOf(Error);
  });
});

describe('pagination', () => {
  it('round trips a cursor and rejects junk', () => {
    const c = encodeCursor({ t: 12, id: 'abc' });
    expect(decodeCursor<{ t: number; id: string }>(c, ['t', 'id'])).toEqual({ t: 12, id: 'abc' });
    expect(decodeCursor(undefined, [])).toBeNull();
    expect(() => decodeCursor('%%%', ['t'])).toThrow(/cursor/);
    expect(() => decodeCursor(encodeCursor({ t: 1 }), ['t', 'id'])).toThrow(/cursor/);
  });
  it('trims the extra row and says whether there is more', () => {
    expect(toPage([1, 2, 3], 3, String)).toEqual({ items: [1, 2, 3], nextCursor: null });
    expect(toPage([1, 2, 3, 4], 3, (n) => `c${n}`)).toEqual({ items: [1, 2, 3], nextCursor: 'c3' });
  });
  it('parses limits with bounds', () => {
    expect(pageQuerySchema.parse({}).limit).toBe(50);
    expect(pageQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(() => pageQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => pageQuerySchema.parse({ limit: '1000' })).toThrow();
    expect(z.number().safeParse(1).success).toBe(true);
  });
});

describe('logger', () => {
  it('redacts anything that looks sensitive, recursively', () => {
    const out = redact({
      email: 'a@b.c',
      nested: { refreshToken: 'x', ok: 1 },
      list: [{ password: 'p' }],
      Authorization: 'Bearer z',
    }) as any;
    expect(out.email).toBe('[redacted]');
    expect(out.nested).toEqual({ refreshToken: '[redacted]', ok: 1 });
    expect(out.list[0].password).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
  });
  it('respects the level and merges child fields', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) }).child({ requestId: 'r1' });
    log.info('hidden');
    log.warn('shown', { a: 1 });
    log.error('also', { token: 't' });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'shown', a: 1, requestId: 'r1' });
    expect(JSON.parse(lines[1]!).token).toBe('[redacted]');
  });
});

describe('rate limiter', () => {
  it('allows up to the limit then blocks until the window ends', async () => {
    const clock = new FakeClock(0);
    const rl = new MemoryRateLimiter(clock);
    for (let i = 0; i < 3; i++) expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
    const blocked = await rl.hit('k', 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    clock.advance(30_000);
    expect((await rl.hit('k', 3, 60)).retryAfterSeconds).toBe(30);
    clock.advance(30_000);
    expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
  });
  it('keeps keys apart and forgets old ones when full', async () => {
    const clock = new FakeClock(0);
    const rl = new MemoryRateLimiter(clock, 2);
    await rl.hit('a', 1, 10);
    await rl.hit('b', 1, 10);
    expect((await rl.hit('a', 1, 10)).allowed).toBe(false);
    clock.advance(11_000);
    expect((await rl.hit('c', 1, 10)).allowed).toBe(true); // triggers a sweep
    expect((await rl.hit('a', 1, 10)).allowed).toBe(true);
  });
});

describe('shared (D1) rate limiter', () => {
  it('allows up to the limit then blocks until the window ends, like the in-memory one', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const clock = new FakeClock(1_000_000);
    const rl = new D1RateLimiter(env.DB, clock);
    for (let i = 0; i < 3; i++) expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
    const blocked = await rl.hit('k', 3, 60);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 60 });
    clock.advance(45_000);
    expect((await rl.hit('k', 3, 60)).retryAfterSeconds).toBe(15);
    clock.advance(15_000);
    expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
    expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
    expect((await rl.hit('k', 3, 60)).allowed).toBe(true);
    expect((await rl.hit('k', 3, 60)).allowed).toBe(false);
  });
  it('keeps keys apart', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const rl = new D1RateLimiter(env.DB, new FakeClock(0));
    expect((await rl.hit('a', 1, 10)).allowed).toBe(true);
    expect((await rl.hit('a', 1, 10)).allowed).toBe(false);
    expect((await rl.hit('b', 1, 10)).allowed).toBe(true);
  });
  it('cannot be squeezed past the limit by simultaneous requests', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const rl = new D1RateLimiter(env.DB, new FakeClock(0));
    const results = await Promise.all(Array.from({ length: 25 }, () => rl.hit('burst', 10, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
  it('the never-limiting stand-in always allows', async () => {
    expect(await unlimited.hit('x', 0, 1)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});

describe('peeking at a limit', () => {
  it('the in-memory limiter reports blocked only once the limit is reached, and counts nothing itself', async () => {
    const clock = new FakeClock(0);
    const rl = new MemoryRateLimiter(clock);
    expect((await rl.peek('k', 2, 60)).allowed).toBe(true);
    await rl.hit('k', 2, 60);
    for (let i = 0; i < 5; i++) expect((await rl.peek('k', 2, 60)).allowed).toBe(true);
    await rl.hit('k', 2, 60);
    expect(await rl.peek('k', 2, 60)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    clock.advance(61_000);
    expect((await rl.peek('k', 2, 60)).allowed).toBe(true);
  });
  it('the shared limiter does the same', async () => {
    await env.DB.exec('DELETE FROM rate_limits');
    const clock = new FakeClock(1_000_000);
    const rl = new D1RateLimiter(env.DB, clock);
    expect((await rl.peek('k', 2, 60)).allowed).toBe(true);
    await rl.hit('k', 2, 60);
    await rl.hit('k', 2, 60);
    expect((await rl.peek('k', 2, 60)).allowed).toBe(false);
    clock.advance(61_000);
    expect((await rl.peek('k', 2, 60)).allowed).toBe(true);
    expect((await unlimited.peek('k', 0, 1)).allowed).toBe(true);
  });
});
