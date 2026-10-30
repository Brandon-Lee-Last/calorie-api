import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../test/helpers/content';
import { MemoryMailer } from '../test/helpers/mailer';
import { MemoryPush } from '../test/helpers/push';
import { FakeAi, toastItem } from '../test/helpers/ai';
import { body, jsonInit, makeApp, signUp } from '../test/helpers/app';
import { clearSettingsCache } from './modules/settings/settings.service';

/**
 * Throws awkward input at EVERY operation in the API description (found by reading it, so a new route is covered the day it is
 * added) and checks the one promise that matters for a service nobody is watching: it never falls over. Whatever arrives, the
 * answer is a well-formed error (or a success), never a 500, never a hang, and the database is still intact afterwards.
 */

type Json = Record<string, any>;

// ---- a small, deterministic random source, so a failure can be reproduced --------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
}

// ---- turn a JSON schema into a plausible value ---------------------------------------------------------------------
function resolve(doc: Json, schema: Json): Json {
  let s = schema;
  for (let i = 0; i < 10 && s?.$ref; i++) {
    s = String(s.$ref)
      .replace(/^#\//, '')
      .split('/')
      .reduce((o: Json, k) => o?.[k], doc);
  }
  return s ?? {};
}

function sample(doc: Json, schema0: Json, depth = 0): unknown {
  const schema = resolve(doc, schema0);
  if (depth > 6) return null;
  if ('const' in schema) return schema.const;
  if (schema.example !== undefined) return schema.example;
  if (schema.enum) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return sample(doc, variants.find((v: Json) => v.type !== 'null') ?? variants[0], depth + 1);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((p: Json) => sample(doc, p, depth + 1)));
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      for (const [k, v] of Object.entries<Json>(schema.properties ?? {})) out[k] = sample(doc, v, depth + 1);
      return out;
    }
    case 'array':
      return [sample(doc, schema.items ?? {}, depth + 1)];
    case 'integer':
    case 'number':
      return Math.max(schema.minimum ?? 0, schema.exclusiveMinimum ?? 0, 1);
    case 'boolean':
      return true;
    case 'string':
      if (schema.format === 'date-time') return new Date(Date.UTC(2026, 9, 21, 12)).toISOString();
      if (schema.format === 'email') return 'person@example.com';
      return 'x'.repeat(Math.max(schema.minLength ?? 1, 1));
    default:
      return 'x';
  }
}

const NASTY_STRINGS = [
  '',
  ' ',
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  '" OR ""="',
  '%',
  '_',
  '\\',
  '\u0000',
  '../../../../etc/passwd',
  '%2e%2e%2f',
  '<script>alert(1)</script>',
  '{{7*7}}',
  '${jndi:ldap://x}',
  '‮\u0000﻿',
  '😀'.repeat(300),
  'ä'.normalize('NFD').repeat(300),
  'x'.repeat(100_000),
  '9'.repeat(400),
  '-1',
  'NaN',
  'null',
  'undefined',
  '[object Object]',
];

function mutations(good: unknown, random: () => number): unknown[] {
  const out: unknown[] = [
    null,
    [],
    'text',
    42,
    true,
    {},
    [[[[[[[[[[1]]]]]]]]]],
    JSON.parse('{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":1}}}}}}}}'),
  ];
  if (good && typeof good === 'object' && !Array.isArray(good)) {
    const keys = Object.keys(good as Json);
    const pick = () => keys[Math.floor(random() * keys.length)]!;
    const wrongType = (v: unknown) =>
      typeof v === 'string' ? 12345 : typeof v === 'number' ? 'twelve' : Array.isArray(v) ? { x: 1 } : 'nope';
    for (let i = 0; i < Math.min(keys.length, 14); i++) {
      const k = keys[i]!;
      const copy = (v: unknown) => ({ ...(good as Json), [k]: v });
      out.push(
        copy(null),
        copy(wrongType((good as Json)[k])),
        copy(NASTY_STRINGS[Math.floor(random() * NASTY_STRINGS.length)]),
      );
      const without = { ...(good as Json) };
      delete without[k];
      out.push(without);
    }
    if (keys.length) {
      const k = pick();
      out.push(
        { ...(good as Json), [k]: -1e308 },
        { ...(good as Json), [k]: 1e308 },
        { ...(good as Json), [k]: 0 },
        { ...(good as Json), [k]: 'x'.repeat(5_000) },
      );
    }
    out.push({
      ...(good as Json),
      unexpected: { deeply: ['nested'] },
      __proto__x: 1,
      constructor: { prototype: { admin: true } },
    });
  }
  return out;
}

// ---- the run -------------------------------------------------------------------------------------------------------
const PATH_VALUES = [
  '01JABCDEFGHJKMNPQRSTVWXYZ0',
  '11111111-2222-4333-8444-555555555555',
  'x',
  "'; DROP TABLE users; --",
  '%00',
  '..%2f..%2f',
  '😀',
  'a'.repeat(3000),
  '0',
  '-1',
];

describe('the API under bad input', () => {
  it('never answers 500, never hangs, and leaves the database intact', async () => {
    const mailer = new MemoryMailer();
    const ai = new FakeAi();
    ai.jsonAnswer = { items: [toastItem] };
    // A usable recipe, so the admin recipe check (which needs no foods of the caller's) can answer 200.
    ai.chatJsonAnswer = {
      recipes: [
        {
          title: 'Oats',
          minutes: 5,
          ingredients: [
            { ref: 'i1', grams: 50 },
            { ref: 'i2', grams: 200 },
          ],
          steps: ['Cook the oats in the milk.', 'Eat warm.'],
        },
      ],
    }; // fmt: skip
    const t = makeApp({ mailer, ai, pushSender: new MemoryPush() });
    const doc = (await body(await t.request('/v1/openapi.json'))) as Json;
    const admin = adminClient(t);
    const random = rng(20261021);

    const problems: string[] = [];
    let requests = 0;
    const statuses = new Map<number, number>();

    async function fire(label: string, path: string, init: RequestInit) {
      requests++;
      let res: Response;
      try {
        res = await t.request(path, init);
      } catch (e) {
        problems.push(`${label}: threw ${String(e).slice(0, 120)}`);
        return;
      }
      // A valid-looking settings change would put the whole API into maintenance mode for the rest of the run: undo it.
      if (path.startsWith('/v1/admin/settings')) {
        await env.DB.exec('DELETE FROM app_settings');
        clearSettingsCache();
      }
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      const text = await res.text();
      if (res.status >= 500 && res.status !== 501 && res.status !== 503)
        problems.push(`${label}: HTTP ${res.status} ${text.slice(0, 160)}`);
      if (res.status >= 400 && (res.headers.get('content-type') ?? '').includes('json')) {
        try {
          const b = JSON.parse(text);
          if (typeof b?.error?.code !== 'string' || typeof b?.error?.requestId !== 'string')
            problems.push(`${label}: error body has the wrong shape: ${text.slice(0, 120)}`);
        } catch {
          problems.push(`${label}: error body is not JSON`);
        }
      }
      if (/at .*\.(ts|js):\d+|node_modules|SQLITE|D1_ERROR|stack/i.test(text) && res.status >= 400)
        problems.push(`${label}: response leaks internals: ${text.slice(0, 160)}`);
    }

    const operations: { method: string; path: string; op: Json }[] = [];
    for (const [path, item] of Object.entries<Json>(doc.paths))
      for (const method of ['get', 'put', 'post', 'patch', 'delete'])
        if (item[method]) operations.push({ method, path, op: item[method] });
    expect(operations.length).toBeGreaterThan(100);

    for (const { method, path, op } of operations) {
      const user = await signUp(t);
      const isAdmin = path.startsWith('/v1/admin');
      const authContexts: Array<{ name: string; headers: Record<string, string> }> = [
        { name: 'anonymous-caller', headers: {} },
        { name: 'signed-in', headers: { authorization: `Bearer ${user.accessToken}` } },
        ...(isAdmin ? [{ name: 'admin', headers: { 'x-admin-key': env.ADMIN_API_KEY } }] : []),
        { name: 'bad-token', headers: { authorization: 'Bearer not.a.token' } },
      ];

      const params: Json[] = (op.parameters ?? []).map((p: Json) => ({
        ...p,
        schema: resolve(doc, p.schema ?? {}),
      }));
      const queryParams = params.filter((p) => p.in === 'query');
      const content = op.requestBody?.content as Json | undefined;
      const jsonSchema = content?.['application/json']?.schema;
      const goodBody = jsonSchema ? sample(doc, jsonSchema) : undefined;

      const goodQuery = new URLSearchParams();
      for (const q of queryParams) goodQuery.set(q.name, String(sample(doc, q.schema)));

      const urlFor = (pathValue: string, query: URLSearchParams) =>
        path.replace(/\{[^}]+\}/g, encodeURIComponent(pathValue)) + (query.size ? `?${query}` : '');

      for (const auth of authContexts) {
        const base = `${method.toUpperCase()} ${path} [${auth.name}]`;
        // 1. path values
        for (const pv of PATH_VALUES.slice(
          0,
          auth.name === 'signed-in' || auth.name === 'admin' ? PATH_VALUES.length : 2,
        )) {
          const init: RequestInit = {
            method: method.toUpperCase(),
            headers: {
              ...auth.headers,
              ...(goodBody !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            ...(goodBody !== undefined && method !== 'get' ? { body: JSON.stringify(goodBody) } : {}),
          };
          await fire(`${base} path=${pv.slice(0, 20)}`, urlFor(pv, goodQuery), init);
        }
        if (auth.name !== 'signed-in' && auth.name !== 'admin') continue;

        // 2. query values
        for (const q of queryParams) {
          for (const nasty of [...NASTY_STRINGS.slice(0, 14), NASTY_STRINGS[17]!]) {
            const query = new URLSearchParams(goodQuery);
            query.set(q.name, nasty);
            await fire(`${base} ?${q.name}=${nasty.slice(0, 20)}`, urlFor(PATH_VALUES[0]!, query), {
              method: method.toUpperCase(),
              headers: auth.headers,
            });
          }
        }
        if (queryParams.length) {
          await fire(
            `${base} repeated query keys`,
            urlFor(
              PATH_VALUES[0]!,
              new URLSearchParams(
                queryParams.flatMap((q) => [
                  [q.name, 'a'],
                  [q.name, 'b'],
                ]),
              ),
            ),
            { method: method.toUpperCase(), headers: auth.headers },
          );
        }

        // 3. bodies
        if (method === 'get' || !content) continue;
        if (jsonSchema) {
          const bodies = mutations(goodBody, random);
          for (const b of bodies)
            await fire(
              `${base} body=${JSON.stringify(b)?.slice(0, 50)}`,
              urlFor(PATH_VALUES[0]!, goodQuery),
              {
                method: method.toUpperCase(),
                headers: { ...auth.headers, 'content-type': 'application/json' },
                body: JSON.stringify(b),
              },
            );
          for (const raw of [
            '',
            '{',
            '{"a":',
            'not json at all',
            '\u0000\u0001',
            '[1,2',
            '{"a":1}{"b":2}',
            'x'.repeat(2_000_000),
          ])
            await fire(`${base} raw=${raw.slice(0, 20)}`, urlFor(PATH_VALUES[0]!, goodQuery), {
              method: method.toUpperCase(),
              headers: { ...auth.headers, 'content-type': 'application/json' },
              body: raw,
            });
          await fire(`${base} wrong content type`, urlFor(PATH_VALUES[0]!, goodQuery), {
            method: method.toUpperCase(),
            headers: { ...auth.headers, 'content-type': 'text/plain' },
            body: JSON.stringify(goodBody),
          });
          await fire(`${base} no content type`, urlFor(PATH_VALUES[0]!, goodQuery), {
            method: method.toUpperCase(),
            headers: auth.headers,
            body: JSON.stringify(goodBody),
          });
        } else {
          const type = Object.keys(content)[0]!;
          const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(random() * 256));
          const variants: Uint8Array[] = [
            new Uint8Array(0),
            bytes(1),
            bytes(64),
            Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, ...bytes(20)]),
            Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...bytes(50)]),
            new Uint8Array(5 * 1024 * 1024),
          ];
          for (const v of variants)
            for (const ct of [type, 'text/plain'])
              await fire(`${base} bytes=${v.length} as ${ct}`, urlFor(PATH_VALUES[0]!, goodQuery), {
                method: method.toUpperCase(),
                headers: { ...auth.headers, 'content-type': ct },
                body: v as BodyInit,
              });
        }
      }
    }

    // unknown routes and methods, odd paths
    for (const path of [
      '/',
      '/v1',
      '/v1/',
      '/v1/%',
      '/v1/%ff',
      '/v1/../etc/passwd',
      '/v1/me/%00',
      `/v1/${'a/'.repeat(500)}`,
      '/%00',
      '/v1/me;x=1',
      '//v1//me',
    ])
      await fire(`GET ${path}`, path, { method: 'GET' });
    for (const method of ['TRACE', 'OPTIONS', 'HEAD', 'PATCH', 'PUT', 'DELETE'])
      await fire(`${method} /v1/health`, '/v1/health', { method });

    expect(problems.slice(0, 25)).toEqual([]);
    expect(requests).toBeGreaterThan(3000);
    // the schema is still there and the people we created are still readable
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users!.n).toBeGreaterThan(0);
    for (const table of ['diary_entries', 'foods', 'subscriptions', 'identities', 'recipes', 'devices'])
      await env.DB.prepare(`SELECT COUNT(*) FROM ${table}`).first();
    void admin;
    void jsonInit;
    console.log(
      `fuzzed ${operations.length} operations with ${requests} requests; statuses`,
      Object.fromEntries([...statuses].sort()),
    );
  }, 600_000);
});
