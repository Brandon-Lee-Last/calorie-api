/** Thin helpers over D1 so repos read as SQL, not plumbing. */

/**
 * D1 occasionally fails a read for a moment (a dropped connection, an overloaded replica). Reads are safe to repeat, so they try
 * a few times with a short pause. Writes are never repeated here: a write that failed on the way back may have happened.
 */
const TRANSIENT =
  /network connection lost|connection (reset|closed)|overloaded|timed? ?out|temporar|try again|reset because|internal error/i;
export const READ_ATTEMPTS = 3;

export async function retryRead<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (attempt >= READ_ATTEMPTS || !TRANSIENT.test(e instanceof Error ? e.message : String(e))) throw e;
      await sleep(20 * attempt * attempt);
    }
  }
}

export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return retryRead(async () => (await stmt.first<T>()) ?? null);
}

/** For a statement that changes data and returns a row (`... RETURNING`): run exactly once, never retried. */
export async function firstOnce<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  return retryRead(async () => (await stmt.all<T>()).results);
}

/** Runs a write and returns how many rows it changed. */
export async function run(stmt: D1PreparedStatement): Promise<number> {
  return (await stmt.run()).meta.changes ?? 0;
}

/** `?,?,?` for an IN (...) list. D1 allows at most 100 bound parameters per statement, so chunk bigger lists. */
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** All statements succeed or none do. */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  return stmts.length === 0 ? [] : db.batch(stmts);
}
