/** Thin helpers over D1 so repos read as SQL, not plumbing. */

export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  return (await stmt.all<T>()).results;
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
