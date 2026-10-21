import type { SubStatus } from '../entitlements';

/** What a store tells us about one purchase. */
export type ProviderSubscription = {
  provider: 'mock' | 'google_play';
  /** The purchase token (or equivalent): unique per purchase, so it identifies the subscription. */
  externalId: string;
  productId: string;
  status: SubStatus;
  autoRenew: boolean;
  startedAt: number;
  currentPeriodEnd: number;
  graceUntil: number | null;
  canceledAt: number | null;
  environment: 'sandbox' | 'production';
  /** Which of our accounts the store says made the purchase (Google: the obfuscated account id the app set), if it says. */
  accountId?: string | null;
};

/**
 * One store. `verify` checks a purchase the app just made; `refresh` re-reads the current state of a purchase we
 * already know (after a notification, or on "restore purchases"). Both return null if the store does not know the
 * token.
 */
export interface BillingProvider {
  readonly name: 'mock' | 'google_play';
  verify(input: {
    productId: string;
    purchaseToken: string;
    userId: string;
  }): Promise<ProviderSubscription | null>;
  refresh(externalId: string, productId: string): Promise<ProviderSubscription | null>;
}
