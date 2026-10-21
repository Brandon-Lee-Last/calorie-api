import { z } from 'zod';
import { badRequest } from './errors';
import { fromBase64Url, toBase64Url } from './crypto';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(512).optional(),
});

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Opaque cursor: base64url of a small JSON object. Clients must not parse it. */
export function encodeCursor(value: Record<string, string | number>): string {
  return toBase64Url(enc.encode(JSON.stringify(value)));
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string | undefined,
  keys: (keyof T & string)[],
): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(dec.decode(fromBase64Url(cursor))) as Record<string, unknown>;
    for (const k of keys) {
      if (!(k in parsed) || (typeof parsed[k] !== 'string' && typeof parsed[k] !== 'number'))
        throw new Error('shape');
    }
    return parsed as T;
  } catch {
    throw badRequest('The cursor is not valid');
  }
}

export type Page<T> = { items: T[]; nextCursor: string | null };

/** Fetch `limit + 1` rows, then call this to trim and decide whether there is a next page. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]!) };
}
