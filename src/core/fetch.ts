/**
 * The global fetch, safe to keep in a field and call as `this.fetcher(...)`. Workers throw "Illegal invocation" when
 * `fetch` itself is called with any `this` but the global one, which is what a field holding `fetch` does.
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);
