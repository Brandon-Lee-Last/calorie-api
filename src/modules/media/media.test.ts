import { describe, expect, it } from 'vitest';
import { parseRange } from './media.service';
import { assertMediaAccess, signMediaAccess } from './media.signing';

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', 1000, { offset: 0, length: 100 }],
    ['bytes=500-', 1000, { offset: 500, length: 500 }],
    ['bytes=-100', 1000, { offset: 900, length: 100 }],
    ['bytes=900-5000', 1000, { offset: 900, length: 100 }],
    ['bytes=0-0', 1000, { offset: 0, length: 1 }],
    ['bytes=-5000', 1000, { offset: 0, length: 1000 }],
    ['bytes=1000-', 1000, 'unsatisfiable'],
    ['bytes=2000-3000', 1000, 'unsatisfiable'],
    ['bytes=-0', 1000, 'unsatisfiable'],
    [null, 1000, null],
    ['', 1000, null],
    ['items=0-5', 1000, null],
    ['bytes=0-5,10-20', 1000, null],
    ['bytes=-', 1000, null],
    ['bytes=50-10', 1000, null],
  ])('%s of %i bytes -> %j', (header, size, expected) => {
    expect(parseRange(header as string | null, size)).toEqual(expected);
  });
});

describe('signed media links', () => {
  const secret = 'a-test-secret-of-sufficient-length-123456';
  const exp = Math.floor(Date.now() / 1000) + 600;
  it('accept their own signature until they expire', async () => {
    const sig = await signMediaAccess(secret, 'media1', exp);
    await expect(assertMediaAccess(secret, 'media1', exp, sig, Date.now())).resolves.toBeUndefined();
    await expect(assertMediaAccess(secret, 'media1', exp, sig, (exp + 1) * 1000)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('reject a different media id, expiry, secret or signature', async () => {
    const sig = await signMediaAccess(secret, 'media1', exp);
    await expect(assertMediaAccess(secret, 'media2', exp, sig, Date.now())).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertMediaAccess(secret, 'media1', exp + 60, sig, Date.now())).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      assertMediaAccess('another-secret-of-sufficient-length-12345', 'media1', exp, sig, Date.now()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(assertMediaAccess(secret, 'media1', exp, `${sig}x`, Date.now())).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertMediaAccess(secret, 'media1', Number.NaN, sig, Date.now())).rejects.toMatchObject({
      status: 403,
    });
  });
});
