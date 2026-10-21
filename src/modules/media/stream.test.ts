import { env } from 'cloudflare:workers';
import { decodeProtectedHeader, exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient, resetContent } from '../../../test/helpers/content';
import { body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { getConfig } from '../../env';
import { FakeClock, HOUR } from '../../core/time';
import { MEDIA_URL_TTL_SECONDS } from './media.signing';
import { CloudflareStreamSigner, noStream } from './stream';

beforeEach(resetContent);

const T0 = Date.UTC(2026, 9, 21, 12);
const KEY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pemBase64 = btoa(await exportPKCS8(privateKey));
  return { pemBase64, verifyKey: await importSPKI(await exportSPKI(publicKey), 'RS256') };
}

describe('CloudflareStreamSigner', () => {
  it('puts a short-lived token, signed with the account’s key, where the video id goes', async () => {
    const { pemBase64, verifyKey } = await keys();
    const clock = new FakeClock(T0);
    const signer = new CloudflareStreamSigner('abcd1234efgh', KEY_ID, pemBase64, clock);
    const link = await signer.sign('video-uid-123', 3600);
    const m = /^https:\/\/customer-abcd1234efgh\.cloudflarestream\.com\/([^/]+)\/manifest\/video\.m3u8$/.exec(
      link.url,
    );
    expect(m).not.toBeNull();
    const token = m![1]!;
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: KEY_ID });
    const { payload } = await jwtVerify(token, verifyKey, { currentDate: new Date(T0) });
    expect(payload).toMatchObject({ sub: 'video-uid-123', kid: KEY_ID, exp: T0 / 1000 + 3600 });
    expect(payload.nbf).toBeLessThan(T0 / 1000);
    expect(link.expiresAt).toBe(T0 + 3600_000);
    // it stops working when it expires
    await expect(jwtVerify(token, verifyKey, { currentDate: new Date(T0 + 2 * HOUR) })).rejects.toThrow();
  });
  it('is named for one video only', async () => {
    const { pemBase64 } = await keys();
    const signer = new CloudflareStreamSigner('abcd1234efgh', KEY_ID, pemBase64, new FakeClock(T0));
    const a = (await signer.sign('video-a', 60)).url;
    const b = (await signer.sign('video-b', 60)).url;
    expect(a).not.toBe(b);
  });
  it('says Stream is not set up when it has no key', async () => {
    await expect(noStream.sign('x', 60)).rejects.toMatchObject({ status: 501 });
  });
});

describe('the media access link for a Stream video', () => {
  async function setup(streamSigner?: CloudflareStreamSigner) {
    const t = makeApp(streamSigner ? { streamSigner } : {});
    const s = await signUp(t);
    const admin = adminClient(t);
    const mk = async (tier: 'free' | 'pro', location: string | null = 'vid-1') =>
      (
        await body(
          await admin.call('PUT', `/v1/admin/media/st-${tier}`, {
            kind: 'video',
            provider: 'stream',
            location,
            tier,
          }),
        )
      ).id as string;
    const access = (id: string) =>
      t.request(`/v1/media/${id}/access`, jsonInit('POST', undefined, s.accessToken));
    return { t, s, admin, mk, access };
  }

  it('hands out a signed playlist link', async () => {
    const { pemBase64 } = await keys();
    const { t, mk, access } = await setup(
      new CloudflareStreamSigner('abcd1234efgh', KEY_ID, pemBase64, new FakeClock(T0)),
    );
    const id = await mk('free');
    const res = await access(id);
    expect(res.status).toBe(200);
    const link = await body(res);
    expect(link.provider).toBe('stream');
    expect(link.url).toMatch(
      /^https:\/\/customer-abcd1234efgh\.cloudflarestream\.com\/.+\/manifest\/video\.m3u8$/,
    );
    expect(link.expiresAt).toBe(T0 + MEDIA_URL_TTL_SECONDS * 1000);
    expect(link.url).not.toContain('vid-1'); // the video id travels inside the signed token, not in the clear
    void t;
  });
  it('keeps Pro videos for Pro accounts', async () => {
    const { pemBase64 } = await keys();
    const { t, s, mk, access } = await setup(
      new CloudflareStreamSigner('abcd1234efgh', KEY_ID, pemBase64, new FakeClock(T0)),
    );
    const id = await mk('pro');
    expect((await access(id)).status).toBe(402);
    await t.request('/v1/subscription/simulate', jsonInit('POST', { scenario: 'subscribe' }, s.accessToken));
    expect((await access(id)).status).toBe(200);
  });
  it('says Stream is not set up where there is no key', async () => {
    const { mk, access } = await setup();
    const res = await access(await mk('free'));
    expect(res.status).toBe(501);
  });
});

describe('Stream settings', () => {
  it('are all or nothing', () => {
    const pem = 'x'.repeat(120);
    expect(() => getConfig({ ...env, STREAM_CUSTOMER_CODE: 'abcd1234efgh' })).toThrow(/together/);
    expect(() =>
      getConfig({ ...env, STREAM_CUSTOMER_CODE: 'abcd1234efgh', STREAM_SIGNING_KEY_ID: KEY_ID }),
    ).toThrow(/together/);
    expect(
      getConfig({
        ...env,
        STREAM_CUSTOMER_CODE: 'abcd1234efgh',
        STREAM_SIGNING_KEY_ID: KEY_ID,
        STREAM_SIGNING_KEY_PEM: pem,
      }).STREAM_CUSTOMER_CODE,
    ).toBe('abcd1234efgh');
    expect(() =>
      getConfig({
        ...env,
        STREAM_CUSTOMER_CODE: 'NOT VALID!',
        STREAM_SIGNING_KEY_ID: KEY_ID,
        STREAM_SIGNING_KEY_PEM: pem,
      }),
    ).toThrow(/STREAM_CUSTOMER_CODE/);
  });
  it('build the real signer from the environment', async () => {
    const { pemBase64 } = await keys();
    const t = makeApp();
    const s = await signUp(t);
    const admin = adminClient(t);
    const id = (
      await body(
        await admin.call('PUT', '/v1/admin/media/st-env', {
          kind: 'video',
          provider: 'stream',
          location: 'vid-9',
          tier: 'free',
        }),
      )
    ).id;
    const res = await t.app.request(`/v1/media/${id}/access`, jsonInit('POST', undefined, s.accessToken), {
      ...env,
      STREAM_CUSTOMER_CODE: 'abcd1234efgh',
      STREAM_SIGNING_KEY_ID: KEY_ID,
      STREAM_SIGNING_KEY_PEM: pemBase64,
    });
    expect(res.status).toBe(200);
    expect((await body(res)).url).toContain('customer-abcd1234efgh.cloudflarestream.com');
  });
});
