#!/usr/bin/env node
// After a deploy: the Worker must answer /v1/health and /v1/health/ready on the deployed host.
// Usage: node scripts/smoke-test.mjs https://api-stage.example.com
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: smoke-test.mjs <base url>');
  process.exit(1);
}

async function check(path, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(base + path);
      if (res.ok) return await res.json();
      console.log(`${path}: HTTP ${res.status} (attempt ${i}/${attempts})`);
    } catch (e) {
      console.log(`${path}: ${e.message} (attempt ${i}/${attempts})`);
    }
    await new Promise((r) => setTimeout(r, 5000 * i)); // a fresh custom domain can take a minute to be reachable
  }
  throw new Error(`${path} never became healthy`);
}

const live = await check('/v1/health');
const ready = await check('/v1/health/ready');
console.log('live:', live, 'ready:', ready);
