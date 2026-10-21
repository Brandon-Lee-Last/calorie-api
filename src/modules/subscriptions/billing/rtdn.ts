import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { unauthorized } from '../../../core/errors';
import type { Clock } from '../../../core/time';

/**
 * Google Pub/Sub delivers each notification as a push request carrying an OpenID Connect token (`Authorization: Bearer ...`)
 * signed by Google. Checking it proves the request came from our own push subscription, not from someone who found the URL.
 */
export class PubSubPushVerifier {
  constructor(
    private audience: string | undefined,
    /** The service account the push subscription signs as. Strongly recommended: without it any Google-signed token for our audience passes. */
    private serviceAccount: string | undefined,
    private clock: Clock,
    private getKey: JWTVerifyGetKey = createRemoteJWKSet(
      new URL('https://www.googleapis.com/oauth2/v3/certs'),
    ),
  ) {}

  get configured() {
    return Boolean(this.audience);
  }

  async verify(authorization: string | undefined): Promise<void> {
    const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!token || !this.audience) throw unauthorized('Not a Pub/Sub push request');
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.audience,
        algorithms: ['RS256'],
        currentDate: new Date(this.clock.now()),
      });
      if (payload.email_verified !== true) throw new Error('email not verified');
      if (this.serviceAccount && payload.email !== this.serviceAccount)
        throw new Error('wrong service account');
    } catch {
      throw unauthorized('Not a Pub/Sub push request');
    }
  }
}

export type PlayNotification =
  | { kind: 'subscription'; token: string; productId: string | null; type: number }
  | { kind: 'voided'; token: string; isSubscription: boolean }
  | { kind: 'test' }
  | { kind: 'ignored'; reason: string };

/** Decode the Pub/Sub envelope and the Play notification inside it. Never throws: odd input is `ignored`. */
export function parseNotification(
  envelope: unknown,
  packageName: string | undefined,
): { messageId: string; notification: PlayNotification } {
  const message = (envelope as { message?: { data?: unknown; messageId?: unknown } } | null)?.message;
  const messageId = typeof message?.messageId === 'string' ? message.messageId : '';
  const ignored = (reason: string) => ({ messageId, notification: { kind: 'ignored', reason } as const });
  if (!message || typeof message.data !== 'string' || !messageId) return ignored('not a Pub/Sub message');
  let n: Record<string, any>;
  try {
    n = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0))));
  } catch {
    return ignored('message body is not JSON');
  }
  if (typeof n !== 'object' || n === null) return ignored('message body is not an object');
  if (n.packageName !== packageName) return ignored('for another app');
  if (n.testNotification) return { messageId, notification: { kind: 'test' } };
  const sub = n.subscriptionNotification;
  if (sub && typeof sub.purchaseToken === 'string')
    return {
      messageId,
      notification: {
        kind: 'subscription',
        token: sub.purchaseToken,
        productId: typeof sub.subscriptionId === 'string' ? sub.subscriptionId : null,
        type: Number(sub.notificationType),
      },
    };
  const voided = n.voidedPurchaseNotification;
  if (voided && typeof voided.purchaseToken === 'string')
    return {
      messageId,
      notification: { kind: 'voided', token: voided.purchaseToken, isSubscription: voided.productType === 1 },
    };
  return ignored('not a subscription notification');
}
