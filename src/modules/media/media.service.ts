import { notConfigured, notFound, subscriptionRequired } from '../../core/errors';
import { timingSafeEqual } from '../../core/crypto';
import type { Clock } from '../../core/time';
import type { MediaRepo, MediaRow } from './media.repo';
import { MEDIA_URL_TTL_SECONDS, assertMediaAccess, signMediaAccess } from './media.signing';
import type { ObjectStorage } from './object-storage';

export const r2Key = (mediaKey: string) => `media/${mediaKey}`;

export type ByteRange = { offset: number; length: number };

/**
 * Parse a single-range `Range: bytes=...` header against a file of `size` bytes.
 * Returns the range to send, 'unsatisfiable' if it lies outside the file, or null to send the whole file
 * (no header, or one we do not understand, such as several ranges).
 */
export function parseRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

export class MediaService {
  constructor(
    private repo: MediaRepo,
    private storage: ObjectStorage,
    private clock: Clock,
    private secret: string,
    private planOf: (userId: string) => Promise<'free' | 'pro'>,
  ) {}

  /** A link the app can hand to a video or image player. Pro media needs a Pro account. */
  async access(userId: string, mediaId: string, origin: string) {
    const media = await this.repo.get(mediaId);
    if (!media) throw notFound('Media');
    if (media.tier === 'pro' && (await this.planOf(userId)) !== 'pro')
      throw subscriptionRequired('This video');
    const base = {
      kind: media.kind,
      mime: media.mime,
      durationS: media.duration_s,
      provider: media.provider,
    };

    if (media.provider === 'external') {
      if (!media.location) throw notFound('Media');
      return { ...base, url: media.location, expiresAt: null };
    }
    if (media.provider === 'stream') throw notConfigured('Cloudflare Stream playback');

    const expires = Math.floor(this.clock.now() / 1000) + MEDIA_URL_TTL_SECONDS;
    const sig = await signMediaAccess(this.secret, media.id, expires);
    return {
      ...base,
      url: `${origin}/v1/media/${media.id}/file?exp=${expires}&sig=${sig}`,
      expiresAt: expires * 1000,
    };
  }

  /** Stream the file for a signed link, honouring Range so players can seek, and ETag so they can cache. */
  async serve(
    mediaId: string,
    exp: number,
    sig: string,
    req: { range: string | null; ifNoneMatch: string | null },
  ): Promise<Response> {
    await assertMediaAccess(this.secret, mediaId, exp, sig, this.clock.now());
    const media = await this.repo.get(mediaId);
    if (!media || media.provider !== 'r2') throw notFound('Media');
    const key = r2Key(media.key);

    const head = await this.storage.head(key);
    if (!head) throw notFound('Media file');
    const etag = head.httpEtag;
    const headers = new Headers({
      'content-type': media.mime ?? head.httpMetadata?.contentType ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      etag,
    });
    if (req.ifNoneMatch && timingSafeEqual(req.ifNoneMatch, etag))
      return new Response(null, { status: 304, headers });

    const range = parseRange(req.range, head.size);
    if (range === 'unsatisfiable') {
      headers.set('content-range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range === null) {
      const object = await this.storage.get(key);
      if (!object) throw notFound('Media file');
      headers.set('content-length', String(head.size));
      return new Response(object.body, { status: 200, headers });
    }
    const object = await this.storage.getRange(key, range);
    if (!object) throw notFound('Media file');
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set('content-length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  isStoredHere(m: MediaRow) {
    return m.provider === 'r2';
  }
}
