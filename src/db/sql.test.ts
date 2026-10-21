import { describe, expect, it } from 'vitest';
import { all, chunk, first, firstOnce, placeholders, retryRead } from './sql';

const noSleep = async () => {};

describe('retryRead', () => {
  it('returns at once when the read works', async () => {
    let calls = 0;
    expect(await retryRead(async () => (++calls, 'ok'), noSleep)).toBe('ok');
    expect(calls).toBe(1);
  });
  it('tries again after a passing failure and gives the answer', async () => {
    let calls = 0;
    const result = await retryRead(async () => {
      if (++calls < 3) throw new Error('D1_ERROR: Network connection lost');
      return 'ok';
    }, noSleep);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
  it('gives up after three tries with the last error', async () => {
    let calls = 0;
    await expect(
      retryRead(async () => {
        ++calls;
        throw new Error('D1 DB is overloaded');
      }, noSleep),
    ).rejects.toThrow('overloaded');
    expect(calls).toBe(3);
  });
  it('does not repeat a failure that repeating cannot fix', async () => {
    for (const message of [
      'D1_ERROR: no such table: nope',
      'UNIQUE constraint failed: users.id',
      'syntax error',
    ]) {
      let calls = 0;
      await expect(
        retryRead(async () => {
          ++calls;
          throw new Error(message);
        }, noSleep),
      ).rejects.toThrow();
      expect(calls, message).toBe(1);
    }
  });
  it('waits a little longer each time', async () => {
    const waits: number[] = [];
    await retryRead(
      (() => {
        let n = 0;
        return async () => {
          if (++n < 3) throw new Error('timed out');
          return 1;
        };
      })(),
      async (ms) => void waits.push(ms),
    );
    expect(waits).toEqual([20, 80]);
  });
  it('copes with a thrown value that is not an Error', async () => {
    await expect(retryRead(async () => Promise.reject('plain string'), noSleep)).rejects.toBe('plain string');
  });
});

describe('first / all / firstOnce', () => {
  const stmt = (results: Array<unknown | Error>) => {
    let i = 0;
    const next = () => {
      const r = results[Math.min(i++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    };
    return {
      calls: () => i,
      stmt: {
        first: async () => next(),
        all: async () => ({ results: next() }),
      } as unknown as D1PreparedStatement,
    };
  };
  it('retry a read that failed for a moment', async () => {
    const a = stmt([new Error('Network connection lost'), { n: 1 }]);
    expect(await first(a.stmt)).toEqual({ n: 1 });
    const b = stmt([new Error('Network connection lost'), [{ n: 2 }]]);
    expect(await all(b.stmt)).toEqual([{ n: 2 }]);
  });
  it('return null for no row', async () => {
    expect(await first(stmt([undefined]).stmt)).toBeNull();
    expect(await firstOnce(stmt([undefined]).stmt)).toBeNull();
  });
  it('firstOnce never repeats, because the statement changes data', async () => {
    const a = stmt([new Error('Network connection lost'), { n: 1 }]);
    await expect(firstOnce(a.stmt)).rejects.toThrow('Network');
    expect(a.calls()).toBe(1);
  });
});

describe('small helpers', () => {
  it('make placeholders and chunks', () => {
    expect(placeholders(3)).toBe('?,?,?');
    expect(placeholders(0)).toBe('');
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
