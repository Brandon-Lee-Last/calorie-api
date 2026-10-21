import { SignJWT, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { FakeClock, MINUTE } from '../../core/time';
import { ACCESS_TTL_SECONDS, TokenService } from './tokens';

const OLD = 'old-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const NEW = 'new-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const T0 = Date.UTC(2026, 9, 21, 12);

describe('access tokens and key rotation', () => {
  it('name the key that signed them', async () => {
    const a = new TokenService(OLD, new FakeClock(T0));
    const b = new TokenService(NEW, new FakeClock(T0));
    const ta = (await a.signAccess('u', 's')).token;
    const tb = (await b.signAccess('u', 's')).token;
    expect(decodeProtectedHeader(ta).kid).toMatch(/^[0-9a-f]{12}$/);
    expect(decodeProtectedHeader(ta).kid).not.toBe(decodeProtectedHeader(tb).kid);
    expect(decodeProtectedHeader(ta).kid).not.toContain(OLD.slice(0, 6));
  });
  it('signed with the old secret still work after rotation, until the previous secret is dropped', async () => {
    const clock = new FakeClock(T0);
    const before = (await new TokenService(OLD, clock).signAccess('u1', 's1')).token;
    const rotated = new TokenService(NEW, clock, OLD);
    expect(await rotated.verifyAccess(before)).toMatchObject({ userId: 'u1', sessionId: 's1' });
    const fresh = (await rotated.signAccess('u2', 's2')).token;
    expect(decodeProtectedHeader(fresh).kid).toBe(
      decodeProtectedHeader((await new TokenService(NEW, clock).signAccess('x', 'y')).token).kid,
    );
    expect(await rotated.verifyAccess(fresh)).toMatchObject({ userId: 'u2' });
    // once the previous secret is removed, tokens signed with it are refused
    await expect(new TokenService(NEW, clock).verifyAccess(before)).rejects.toMatchObject({ status: 401 });
  });
  it('signed before keys had names (no kid) are tried against every key', async () => {
    const clock = new FakeClock(T0);
    const iat = Math.floor(T0 / 1000);
    const legacy = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('legacy')
      .setIssuer('calorie-api')
      .setAudience('calorie-app')
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TTL_SECONDS)
      .sign(new TextEncoder().encode(OLD));
    expect(await new TokenService(OLD, clock).verifyAccess(legacy)).toMatchObject({ userId: 'legacy' });
    expect(await new TokenService(NEW, clock, OLD).verifyAccess(legacy)).toMatchObject({ userId: 'legacy' });
    await expect(new TokenService(NEW, clock).verifyAccess(legacy)).rejects.toMatchObject({ status: 401 });
  });
  it('with an unknown key name are still refused', async () => {
    const clock = new FakeClock(T0);
    const iat = Math.floor(T0 / 1000);
    const forged = await new SignJWT({ sid: 's' })
      .setProtectedHeader({ alg: 'HS256', kid: 'doesnotexist' })
      .setSubject('u')
      .setIssuer('calorie-api')
      .setAudience('calorie-app')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(new TextEncoder().encode('x'.repeat(48)));
    await expect(new TokenService(NEW, clock, OLD).verifyAccess(forged)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('expire with the expired error, not a generic one, on either key', async () => {
    const clock = new FakeClock(T0);
    const svc = new TokenService(NEW, clock, OLD);
    const t = (await svc.signAccess('u', 's')).token;
    clock.advance(16 * MINUTE);
    await expect(svc.verifyAccess(t)).rejects.toMatchObject({ code: 'token_expired' });
    const oldT = (await new TokenService(OLD, new FakeClock(T0)).signAccess('u', 's')).token;
    await expect(svc.verifyAccess(oldT)).rejects.toMatchObject({ code: 'token_expired' });
  });
  it('reject junk', async () => {
    const svc = new TokenService(NEW, new FakeClock(T0), OLD);
    for (const junk of ['', 'abc', 'a.b.c', 'a..c', '....'])
      await expect(svc.verifyAccess(junk)).rejects.toMatchObject({ status: 401 });
  });
  it('ignore a previous secret that equals the current one', async () => {
    const svc = new TokenService(NEW, new FakeClock(T0), NEW);
    expect(await svc.verifyAccess((await svc.signAccess('u', 's')).token)).toMatchObject({ userId: 'u' });
  });
});
