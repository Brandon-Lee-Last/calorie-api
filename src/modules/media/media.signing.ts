import { hmacSha256Base64Url, timingSafeEqual } from '../../core/crypto';
import { forbidden } from '../../core/errors';

export const MEDIA_URL_TTL_SECONDS = 60 * 60;

const message = (mediaId: string, expires: number) => `media:${mediaId}:${expires}`;

/** A short signature proving the Worker agreed, at `expires`, to let someone fetch this media. */
export async function signMediaAccess(secret: string, mediaId: string, expires: number): Promise<string> {
  return hmacSha256Base64Url(secret, message(mediaId, expires));
}

/** Throws 403 unless the signature is genuine and has not expired. `expires` is in seconds since the epoch. */
export async function assertMediaAccess(
  secret: string,
  mediaId: string,
  expires: number,
  signature: string,
  nowMs: number,
): Promise<void> {
  if (!Number.isFinite(expires) || expires * 1000 < nowMs) throw forbidden('This link has expired');
  const expected = await signMediaAccess(secret, mediaId, expires);
  if (!timingSafeEqual(expected, signature)) throw forbidden('This link is not valid');
}
