import { SignJWT, importPKCS8 } from 'jose';
import { notConfigured } from '../../core/errors';
import type { Clock } from '../../core/time';

export type StreamLink = { url: string; expiresAt: number };

/** Makes a short-lived playback link for a video held in Cloudflare Stream. */
export interface StreamSigner {
  sign(videoId: string, ttlSeconds: number): Promise<StreamLink>;
}

/** Stream is not set up: asking for a link says so, and nothing is signed. */
export const noStream: StreamSigner = {
  sign: async () => {
    throw notConfigured('Cloudflare Stream playback');
  },
};

/**
 * Signed playback for Stream videos that are set to "require signed URLs". The Worker signs a short JWT with the account's
 * Stream signing key (created once with `POST /accounts/{id}/stream/keys`), and the player asks Stream for the video with the
 * token in place of the video id, so a link stops working when it expires and cannot be reused for another video.
 * See https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/
 */
export class CloudflareStreamSigner implements StreamSigner {
  private key: Promise<CryptoKey> | undefined;

  constructor(
    private customerCode: string,
    private keyId: string,
    /** The `pem` field the key-creation call returns: a base64 encoded PEM private key. */
    private pemBase64: string,
    private clock: Clock,
  ) {}

  private privateKey() {
    this.key ??= importPKCS8(atob(this.pemBase64), 'RS256');
    return this.key;
  }

  async sign(videoId: string, ttlSeconds: number): Promise<StreamLink> {
    const now = Math.floor(this.clock.now() / 1000);
    const exp = now + ttlSeconds;
    const token = await new SignJWT({ sub: videoId, kid: this.keyId })
      .setProtectedHeader({ alg: 'RS256', kid: this.keyId })
      .setNotBefore(now - 30) // a little slack for clocks that run behind
      .setExpirationTime(exp)
      .sign(await this.privateKey());
    return {
      url: `https://customer-${this.customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`,
      expiresAt: exp * 1000,
    };
  }
}
