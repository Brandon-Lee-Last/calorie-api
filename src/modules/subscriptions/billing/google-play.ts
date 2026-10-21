import { notConfigured } from '../../../core/errors';
import type { BillingProvider } from './provider';

/**
 * Google Play Billing. NOT IMPLEMENTED YET: it needs a Play developer account, a published app with subscription products,
 * and a service account with access to the Play Developer API.
 *
 * What to build when those exist:
 *  - verify/refresh: GET androidpublisher v3 `purchases.subscriptionsv2.get` for the purchase token (OAuth2 with the service
 *    account), map `subscriptionState` onto our statuses (ACTIVE -> active, IN_GRACE_PERIOD -> in_grace, ON_HOLD -> on_hold,
 *    PAUSED -> paused, CANCELED -> canceled until expiry, EXPIRED -> expired), then `purchases.subscriptions.acknowledge`
 *    within 3 days or Google refunds the purchase.
 *  - bind a purchase to the account with `obfuscatedExternalAccountId` = our user id (set by the app at purchase time) and
 *    reject tokens whose id differs.
 *  - Real-time developer notifications: a Pub/Sub push to POST /v1/webhooks/google-play, verified by its OIDC token.
 *
 * Until then every call says so, and nobody can be granted Pro through this provider.
 */
export class GooglePlayBillingProvider implements BillingProvider {
  readonly name = 'google_play' as const;

  async verify(): Promise<never> {
    throw notConfigured('Google Play billing');
  }

  async refresh(): Promise<never> {
    throw notConfigured('Google Play billing');
  }
}
