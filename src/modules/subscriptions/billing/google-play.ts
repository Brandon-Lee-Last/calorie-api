import { conflict, notConfigured, upstreamFailed } from '../../../core/errors';
import type { GoogleServiceAccountAuth } from '../../../core/google-auth';
import type { Logger } from '../../../core/logger';
import { DAY, type Clock } from '../../../core/time';
import type { SubStatus } from '../entitlements';
import type { BillingProvider, ProviderSubscription } from './provider';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** The parts of `purchases.subscriptionsv2.get` we read. Every field is optional because we do not trust the shape. */
export type PlayPurchase = {
  subscriptionState?: string;
  startTime?: string;
  acknowledgementState?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  canceledStateContext?: { userInitiatedCancellation?: { cancelTime?: string } };
  lineItems?: {
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerPhase?: { freeTrial?: object };
  }[];
}; // fmt: skip

/** How long to keep granting access while Google says "grace period", if its expiry time does not already cover it. */
const GRACE_FALLBACK_MS = 3 * DAY;

const STATES: Record<string, SubStatus | undefined> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'in_grace',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
};

const ms = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * Turn Google's description of a purchase into ours. Null when it is not a purchase that can grant anything: still pending
 * payment, cancelled before it started, or something we do not recognise. Pure.
 */
export function mapPurchase(
  p: PlayPurchase,
  token: string,
  now: number,
  wantedProduct?: string,
): ProviderSubscription | null {
  const status = STATES[p.subscriptionState ?? ''];
  const items = p.lineItems ?? [];
  const item = items.find((i) => i.productId === wantedProduct) ?? items[0];
  const expiry = ms(item?.expiryTime);
  if (!status || !item?.productId || expiry === null) return null;
  const started = ms(p.startTime) ?? now;
  const canceledAt =
    status === 'canceled' ? (ms(p.canceledStateContext?.userInitiatedCancellation?.cancelTime) ?? now) : null;
  return {
    provider: 'google_play',
    externalId: token,
    productId: item.productId,
    status: status === 'active' && item.offerPhase?.freeTrial ? 'trialing' : status,
    autoRenew: item.autoRenewingPlan?.autoRenewEnabled === true && status !== 'canceled',
    startedAt: started,
    currentPeriodEnd: expiry,
    graceUntil: status === 'in_grace' ? Math.max(expiry, now + GRACE_FALLBACK_MS) : null,
    canceledAt,
    environment: p.testPurchase ? 'sandbox' : 'production',
    accountId: p.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
  }; // fmt: skip
}

/**
 * Google Play Billing, through the Play Developer API.
 *
 * WRITTEN FROM GOOGLE'S DOCUMENTATION AND TESTED AGAINST A FAKE. It has never talked to the real Play API, because that needs a
 * Play developer account, a published app with subscription products and a service account with access. Before launch, test
 * a purchase end to end with a licence tester account, and check in particular: how a free trial shows up (`offerPhase`), what
 * `expiryTime` is during a grace period, and the acknowledge call.
 *
 * Safety properties that hold regardless:
 *  - a purchase only counts for the account named in `obfuscatedExternalAccountId` (the app sets it to the user id at purchase);
 *  - the product the store reports must be the product the app claimed;
 *  - purchases are acknowledged (Google refunds unacknowledged ones after 3 days), and a failed acknowledge is retried later.
 */
export class GooglePlayBillingProvider implements BillingProvider {
  readonly name = 'google_play' as const;

  constructor(
    private auth: GoogleServiceAccountAuth,
    private packageName: string | undefined,
    private clock: Clock,
    private logger: Logger,
    private fetcher: typeof fetch = fetch,
  ) {}

  async verify(input: { productId: string; purchaseToken: string; userId: string }) {
    const purchase = await this.fetchPurchase(input.purchaseToken);
    if (!purchase) return null;
    const mapped = mapPurchase(purchase, input.purchaseToken, this.clock.now(), input.productId);
    if (!mapped || mapped.productId !== input.productId) return null;
    if (mapped.accountId !== input.userId)
      throw conflict('This purchase was made by a different account', {
        reason: 'purchase_belongs_to_another_account',
      });
    await this.acknowledgeIfNeeded(purchase, input.purchaseToken, mapped.productId);
    return mapped;
  }

  async refresh(externalId: string, productId: string) {
    const purchase = await this.fetchPurchase(externalId);
    if (!purchase) return null;
    const mapped = mapPurchase(purchase, externalId, this.clock.now(), productId || undefined);
    if (mapped) await this.acknowledgeIfNeeded(purchase, externalId, mapped.productId);
    return mapped;
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    if (!this.packageName || !this.auth.configured) throw notConfigured('Google Play billing');
    const access = await this.auth.token(SCOPE);
    try {
      return await this.fetcher(`${API}/${encodeURIComponent(this.packageName)}/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      });
    } catch {
      throw upstreamFailed('Google Play');
    }
  }

  private async fetchPurchase(token: string): Promise<PlayPurchase | null> {
    const res = await this.call(`purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
    // Google answers 400/404/410 for a token it does not know (or one that is too old to read): not a purchase.
    if (res.status === 400 || res.status === 404 || res.status === 410) return null;
    if (!res.ok) {
      this.logger.error('google play refused a purchase lookup', { status: res.status });
      throw upstreamFailed('Google Play');
    }
    return (await res.json()) as PlayPurchase;
  }

  private async acknowledgeIfNeeded(p: PlayPurchase, token: string, productId: string) {
    if (p.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_PENDING') return;
    try {
      const res = await this.call(
        `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
        { method: 'POST', body: '{}' },
      );
      if (!res.ok) this.logger.error('google play acknowledge failed', { status: res.status });
    } catch (e) {
      // The person has paid; do not lock them out over this. The next refresh tries again, and Google allows three days.
      this.logger.error('google play acknowledge failed', { message: String(e) });
    }
  }
}
