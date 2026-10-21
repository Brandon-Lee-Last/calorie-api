import { notConfigured } from '../../../core/errors';
import { newId } from '../../../core/ids';
import type { Logger } from '../../../core/logger';
import type { Clock } from '../../../core/time';
import type { SubscriptionsRepo } from '../subscriptions.repo';
import type { SubscriptionsService } from '../subscriptions.service';
import { parseNotification, type PubSubPushVerifier } from './rtdn';

/**
 * Handles Google Play real-time developer notifications.
 *
 * Whatever the notification says, the truth is re-read from the Play API: a notification only tells us WHICH purchase changed,
 * so a forged, reordered or repeated one cannot make us believe something false. Answers are chosen for Pub/Sub, which
 * redelivers anything that is not a 2xx: a message we can never act on is acknowledged and logged, and a failure that may pass
 * (the Play API being down) is let through as an error so Pub/Sub tries again.
 */
export class GooglePlayNotifications {
  constructor(
    private verifier: PubSubPushVerifier,
    private subscriptions: SubscriptionsService,
    private repo: SubscriptionsRepo,
    private packageName: string | undefined,
    private enabled: boolean,
    private clock: Clock,
    private logger: Logger,
  ) {}

  async handle(authorization: string | undefined, envelope: unknown): Promise<void> {
    if (!this.enabled || !this.verifier.configured || !this.packageName)
      throw notConfigured('Google Play notifications');
    await this.verifier.verify(authorization);

    const { messageId, notification } = parseNotification(envelope, this.packageName);
    if (notification.kind === 'ignored' || notification.kind === 'test') {
      if (notification.kind === 'ignored')
        this.logger.warn('play notification ignored', { reason: notification.reason });
      return;
    }
    const key = `gp:${messageId}`;
    if (await this.repo.hasEvent(key)) return; // Pub/Sub delivers at least once

    let outcome: string;
    if (notification.kind === 'subscription') {
      outcome = await this.subscriptions.syncFromStore(notification.token, notification.productId);
    } else if (notification.isSubscription) {
      outcome = (await this.subscriptions.markRefunded(notification.token)) ? 'refunded' : 'unknown_purchase';
    } else {
      outcome = 'not_a_subscription';
    }
    if (outcome === 'unknown_purchase' || outcome === 'unknown_account')
      this.logger.warn('play notification for a purchase we cannot place', { outcome });
    await this.repo.recordEvent(
      newId(this.clock.now()),
      null,
      key,
      notification.kind,
      outcome,
      this.clock.now(),
    );
  }
}
