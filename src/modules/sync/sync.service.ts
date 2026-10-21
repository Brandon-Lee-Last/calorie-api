import type { ZodType } from 'zod';
import { isAppError } from '../../core/errors';
import type { Logger } from '../../core/logger';
import { first } from '../../db/sql';
import { waterTable, weightTable } from '../body/body.repo';
import { toWater, toWeight, type BodyService } from '../body/body.service';
import { entriesTable } from '../diary/diary.repo';
import { entryInputSchema } from '../diary/diary.schemas';
import { toEntry, type DiaryService } from '../diary/diary.service';
import { foodsTable } from '../foods/foods.repo';
import { foodInputSchema } from '../foods/foods.schemas';
import { toFood, type FoodsService } from '../foods/foods.service';
import { waterInputSchema, weightInputSchema } from '../body/body.schemas';
import { zodDetails } from '../../middleware/error-handler';
import type { SYNC_TYPES } from './sync.schemas';

export type SyncType = (typeof SYNC_TYPES)[number];
export type PushOp = {
  type: SyncType;
  id: string;
  op: 'upsert' | 'delete';
  data?: Record<string, unknown>;
  clientUpdatedAt?: number;
};
export type PushResult = {
  type: SyncType;
  id: string;
  status: 'applied' | 'stale' | 'noop' | 'error';
  record?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type Change =
  | { type: 'diary_entry'; record: ReturnType<typeof toEntry> }
  | { type: 'weight'; record: ReturnType<typeof toWeight> }
  | { type: 'water'; record: ReturnType<typeof toWater> }
  | { type: 'food'; record: ReturnType<typeof toFood> };

export class SyncService {
  constructor(
    private db: D1Database,
    private diary: DiaryService,
    private body: BodyService,
    private foods: FoodsService,
    private logger: Logger,
  ) {}

  /**
   * Everything that changed after revision `since`. The upper bound is read first and the changes are limited to it, so
   * a write that lands while we read is returned by the next pull instead of being skipped.
   */
  async pull(
    userId: string,
    since: number,
    limit: number,
  ): Promise<{ changes: Change[]; rev: number; hasMore: boolean }> {
    const head = await first<{ sync_rev: number }>(
      this.db.prepare('SELECT sync_rev FROM users WHERE id = ?').bind(userId),
    );
    const upper = head?.sync_rev ?? 0;
    if (since >= upper) return { changes: [], rev: Math.max(upper, 0), hasMore: false };

    const [entries, weights, waters, foods] = await Promise.all([
      entriesTable.changesSince<never>(this.db, userId, since, limit + 1, upper),
      weightTable.changesSince<never>(this.db, userId, since, limit + 1, upper),
      waterTable.changesSince<never>(this.db, userId, since, limit + 1, upper),
      foodsTable.changesSince<never>(this.db, userId, since, limit + 1, upper),
    ]);
    const all: Change[] = [
      ...entries.map((r) => ({ type: 'diary_entry' as const, record: toEntry(r) })),
      ...weights.map((r) => ({ type: 'weight' as const, record: toWeight(r) })),
      ...waters.map((r) => ({ type: 'water' as const, record: toWater(r) })),
      ...foods.map((r) => ({ type: 'food' as const, record: toFood(r, userId) })),
    ].sort((a, b) => a.record.rev - b.record.rev);

    if (all.length > limit) {
      const changes = all.slice(0, limit);
      return { changes, rev: changes[changes.length - 1]!.record.rev, hasMore: true };
    }
    return { changes: all, rev: upper, hasMore: false };
  }

  async push(userId: string, ops: PushOp[]): Promise<{ results: PushResult[] }> {
    const results: PushResult[] = [];
    for (const op of ops) results.push(await this.apply(userId, op));
    return { results };
  }

  private async apply(userId: string, op: PushOp): Promise<PushResult> {
    try {
      return op.op === 'delete' ? await this.applyDelete(userId, op) : await this.applyUpsert(userId, op);
    } catch (e) {
      if (isAppError(e))
        return {
          type: op.type,
          id: op.id,
          status: 'error',
          error: { code: e.code, message: e.message, details: e.details },
        };
      this.logger.error('sync push op failed', {
        type: op.type,
        message: e instanceof Error ? e.message : String(e),
      });
      return {
        type: op.type,
        id: op.id,
        status: 'error',
        error: { code: 'internal_error', message: 'Something went wrong on our side' },
      };
    }
  }

  private async applyUpsert(userId: string, op: PushOp): Promise<PushResult> {
    const parse = <T>(schema: ZodType<T>): T | PushResult => {
      const r = schema.safeParse(op.data ?? {});
      return r.success
        ? r.data
        : {
            type: op.type,
            id: op.id,
            status: 'error',
            error: {
              code: 'validation_failed',
              message: 'The record is not valid',
              details: zodDetails(r.error),
            },
          };
    };
    const isFailure = (x: unknown): x is PushResult =>
      typeof x === 'object' && x !== null && 'status' in x && 'type' in x && 'error' in x;

    let result: { applied: boolean; record: unknown };
    switch (op.type) {
      case 'diary_entry': {
        const d = parse(entryInputSchema);
        if (isFailure(d)) return d;
        result = await this.diary.put(userId, op.id, d);
        break;
      }
      case 'weight': {
        const d = parse(weightInputSchema);
        if (isFailure(d)) return d;
        result = await this.body.putWeight(userId, op.id, d);
        break;
      }
      case 'water': {
        const d = parse(waterInputSchema);
        if (isFailure(d)) return d;
        result = await this.body.putWater(userId, op.id, d);
        break;
      }
      case 'food': {
        const d = parse(foodInputSchema);
        if (isFailure(d)) return d;
        result = await this.foods.putCustom(userId, op.id, d);
        break;
      }
    }
    return { type: op.type, id: op.id, status: result.applied ? 'applied' : 'stale', record: result.record };
  }

  private async applyDelete(userId: string, op: PushOp): Promise<PushResult> {
    let outcome: 'applied' | 'stale' | 'noop';
    switch (op.type) {
      case 'diary_entry':
        outcome = (await this.diary.delete(userId, op.id, op.clientUpdatedAt)).outcome;
        break;
      case 'weight':
        outcome = (await this.body.deleteWeight(userId, op.id, op.clientUpdatedAt)).outcome;
        break;
      case 'water':
        outcome = (await this.body.deleteWater(userId, op.id, op.clientUpdatedAt)).outcome;
        break;
      case 'food':
        outcome = (await this.foods.deleteCustom(userId, op.id, op.clientUpdatedAt)).outcome;
        break;
    }
    return { type: op.type, id: op.id, status: outcome };
  }
}
