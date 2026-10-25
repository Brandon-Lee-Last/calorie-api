import { describe, expect, it } from 'vitest';
import { globalFetch } from './fetch';

describe('globalFetch', () => {
  it('can be called as a method, where the Workers fetch itself throws "Illegal invocation"', async () => {
    // An address that is not a URL fails before any network traffic, so only the call itself is tested.
    const holder = { raw: fetch, safe: globalFetch };
    await expect(async () => holder.raw('not a url')).rejects.toThrow(/Illegal invocation/);
    await expect(async () => holder.safe('not a url')).rejects.toThrow(/URL/i);
    await expect(async () => holder.safe('not a url')).rejects.not.toThrow(/Illegal invocation/);
  });
});
