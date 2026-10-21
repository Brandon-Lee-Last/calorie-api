import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient, resetContent } from '../../../test/helpers/content';
import { MINUTE } from '../../core/time';
import { authed, body, jsonInit, makeApp, signUp } from '../../../test/helpers/app';
import { MEDIA_URL_TTL_SECONDS } from './media.signing';

beforeEach(resetContent);

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);

async function setup() {
  const t = makeApp();
  const s = await signUp(t);
  const admin = adminClient(t);
  const mk = async (key: string, tier: 'free' | 'pro', extra: Record<string, unknown> = {}) => {
    const m = await body(
      await admin.call('PUT', `/v1/admin/media/${key}`, { kind: 'video', provider: 'r2', tier, ...extra }),
    );
    await admin.upload(key, BYTES, 'video/mp4');
    return m.id as string;
  };
  const access = (id: string, token = s.accessToken) =>
    t.request(`/v1/media/${id}/access`, jsonInit('POST', undefined, token));
  /** The link comes back as an absolute URL; the test app serves it by path. */
  const fetchLink = (url: string, headers: Record<string, string> = {}) => {
    const u = new URL(url);
    return t.request(u.pathname + u.search, { headers });
  };
  return { t, s, admin, mk, access, fetchLink };
}

describe('media access', () => {
  it('gives a signed link to free media and serves the whole file', async () => {
    const { mk, access, fetchLink } = await setup();
    const id = await mk('free-clip', 'free');
    const res = await access(id);
    expect(res.status).toBe(200);
    const link = await body(res);
    expect(link).toMatchObject({ kind: 'video', mime: 'video/mp4', provider: 'r2' });
    expect(link.url).toMatch(new RegExp(`/v1/media/${id}/file\\?exp=\\d+&sig=`));
    const file = await fetchLink(link.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(file.headers.get('accept-ranges')).toBe('bytes');
    expect(file.headers.get('content-length')).toBe('1000');
    expect(file.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
  });
  it('lets players seek with Range requests', async () => {
    const { mk, access, fetchLink } = await setup();
    const link = (await body(await access(await mk('seek', 'free')))).url;
    const part = await fetchLink(link, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(part.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(BYTES.slice(100, 200));
    const tail = await fetchLink(link, { range: 'bytes=-50' });
    expect(tail.headers.get('content-range')).toBe('bytes 950-999/1000');
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(BYTES.slice(950));
    const open = await fetchLink(link, { range: 'bytes=990-' });
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(BYTES.slice(990));
    const past = await fetchLink(link, { range: 'bytes=5000-6000' });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */1000');
  });
  it('answers 304 when the player already has the file', async () => {
    const { mk, access, fetchLink } = await setup();
    const link = (await body(await access(await mk('cached', 'free')))).url;
    const etag = (await fetchLink(link)).headers.get('etag')!;
    expect(etag).toBeTruthy();
    const again = await fetchLink(link, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect((await fetchLink(link, { 'if-none-match': '"other"' })).status).toBe(200);
  });
  it('keeps Pro media for Pro accounts', async () => {
    const { t, s, mk, access } = await setup();
    const id = await mk('pro-clip', 'pro');
    const denied = await access(id);
    expect(denied.status).toBe(402);
    await t.request('/v1/subscription/simulate', jsonInit('POST', { scenario: 'subscribe' }, s.accessToken));
    expect((await access(id)).status).toBe(200);
  });
  it('needs sign-in to ask, and 404s unknown media', async () => {
    const { t, access } = await setup();
    expect((await t.request('/v1/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/access', jsonInit('POST'))).status).toBe(
      401,
    );
    expect((await access('01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
    expect((await access('nope')).status).toBe(422);
  });
  it('links stop working after an hour, and cannot be tampered with or moved to other media', async () => {
    const { t, mk, access, fetchLink } = await setup();
    const a = await mk('clip-a', 'free');
    const b = await mk('clip-b', 'free');
    const link = (await body(await access(a))).url as string;
    expect((await fetchLink(link)).status).toBe(200);
    expect((await fetchLink(link.replace(/sig=.{4}/, 'sig=AAAA'))).status).toBe(403);
    expect((await fetchLink(link.replace(a, b))).status).toBe(403);
    const exp = Number(/exp=(\d+)/.exec(link)![1]);
    expect((await fetchLink(link.replace(`exp=${exp}`, `exp=${exp + 3600}`))).status).toBe(403);
    t.clock.advance((MEDIA_URL_TTL_SECONDS + 1) * 1000);
    const expired = await fetchLink(link);
    expect(expired.status).toBe(403);
    expect((await body(expired)).error.message).toMatch(/expired/);
    void MINUTE;
  });
  it('does not serve a file that was deleted', async () => {
    const { mk, access, fetchLink } = await setup();
    const id = await mk('gone', 'free');
    const link = (await body(await access(id))).url;
    await env.MEDIA.delete('media/gone');
    expect((await fetchLink(link)).status).toBe(404);
  });
  it('hands out external links directly', async () => {
    const { admin, access, s } = await setup();
    const ext = await body(
      await admin.call('PUT', '/v1/admin/media/yt', {
        kind: 'video',
        provider: 'external',
        location: 'https://cdn.example.com/a.mp4',
        tier: 'free',
      }),
    );
    const link = await body(await access(ext.id));
    expect(link).toMatchObject({
      url: 'https://cdn.example.com/a.mp4',
      expiresAt: null,
      provider: 'external',
    });
    (void s, authed);
  });
});
