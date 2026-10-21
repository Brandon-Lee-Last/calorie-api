import { all, first, run } from '../../db/sql';
import type { SubStatus } from './entitlements';
import type { ProviderSubscription } from './billing/provider';

export type SubscriptionRow = {
  id: string;
  user_id: string;
  provider: 'mock' | 'google_play';
  product_id: string;
  external_id: string;
  status: SubStatus;
  auto_renew: number;
  started_at: number;
  current_period_end: number;
  grace_until: number | null;
  canceled_at: number | null;
  environment: 'sandbox' | 'production';
  created_at: number;
  updated_at: number;
}; // fmt: skip

export class SubscriptionsRepo {
  constructor(private db: D1Database) {}

  listForUser(userId: string): Promise<SubscriptionRow[]> {
    return all<SubscriptionRow>(
      this.db
        .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
        .bind(userId),
    );
  }

  findByExternal(provider: string, externalId: string): Promise<SubscriptionRow | null> {
    return first<SubscriptionRow>(
      this.db
        .prepare('SELECT * FROM subscriptions WHERE provider = ? AND external_id = ?')
        .bind(provider, externalId),
    );
  }

  async insert(id: string, userId: string, s: ProviderSubscription, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          `INSERT INTO subscriptions (id, user_id, provider, product_id, external_id, status, auto_renew, started_at,
             current_period_end, grace_until, canceled_at, environment, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          userId,
          s.provider,
          s.productId,
          s.externalId,
          s.status,
          s.autoRenew ? 1 : 0,
          s.startedAt,
          s.currentPeriodEnd,
          s.graceUntil,
          s.canceledAt,
          s.environment,
          now,
          now,
        ),
    ); // fmt: skip
  }

  async applyState(id: string, s: ProviderSubscription, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          `UPDATE subscriptions SET status = ?, auto_renew = ?, started_at = ?, current_period_end = ?, grace_until = ?,
             canceled_at = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          s.status,
          s.autoRenew ? 1 : 0,
          s.startedAt,
          s.currentPeriodEnd,
          s.graceUntil,
          s.canceledAt,
          now,
          id,
        ),
    );
  }

  async userExists(userId: string): Promise<boolean> {
    return (
      (await first(
        this.db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId),
      )) !== null
    );
  }

  async hasEvent(eventKey: string): Promise<boolean> {
    return (
      (await first(
        this.db.prepare('SELECT 1 AS x FROM subscription_events WHERE event_key = ?').bind(eventKey),
      )) !== null
    );
  }

  /** Subscriptions to re-read: ones in a shaky state, and ones whose period ends before `until`. Oldest check first. */
  dueForReconcile(provider: string, until: number, limit: number): Promise<SubscriptionRow[]> {
    return all<SubscriptionRow>(
      this.db
        .prepare(
          `SELECT * FROM subscriptions WHERE provider = ?
             AND (status IN ('in_grace', 'on_hold', 'paused') OR (status IN ('active', 'trialing', 'canceled') AND current_period_end < ?))
             AND status NOT IN ('expired', 'refunded')
           ORDER BY updated_at LIMIT ?`,
        )
        .bind(provider, until, limit),
    );
  }

  /** Record a store notification once. Returns false if this exact notification was already recorded. */
  async recordEvent(
    id: string,
    subscriptionId: string | null,
    eventKey: string,
    type: string,
    payload: string | null,
    now: number,
  ): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare(
            'INSERT OR IGNORE INTO subscription_events (id, subscription_id, event_key, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(id, subscriptionId, eventKey, type, payload, now),
      )) === 1
    );
  }
}
