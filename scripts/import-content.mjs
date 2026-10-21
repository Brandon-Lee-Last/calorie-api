#!/usr/bin/env node
// Loads workout content (media, exercises, programs) from a folder into an environment through the admin API.
// Safe to run again: everything is addressed by its slug or key, so it updates in place.
//
//   API_BASE=https://api-stage.example.com ADMIN_API_KEY=... node scripts/import-content.mjs content/sample [--publish]
//
// Folder layout:
//   media/*.json       { "key": "squat-demo", "kind": "video", "provider": "external", "location": "https://...", "tier": "free" }
//   exercises/*.json   { "slug": "barbell-back-squat", "name": "...", "muscleGroups": [...], ... }
//   programs/*.json    { "slug": "beginner-strength", "title": "...", "workouts": [...], ... }
// Files are read in that order: media first, then exercises, then programs, because each refers to the one before.
// Only use content you own or are licensed to use. Put credit in each exercise's "source" and "licence".
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read every JSON file in a folder, sorted by name. */
export function readJsonFolder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

/** The requests to make, in order. Pure, so it can be checked without a server. */
export function planImport(root, { publish = false } = {}) {
  const steps = [];
  for (const { file, data } of readJsonFolder(join(root, 'media'))) {
    const { key, ...body } = data;
    if (!key) throw new Error(`media/${file}: missing "key"`);
    steps.push({ label: `media ${key}`, method: 'PUT', path: `/v1/admin/media/${key}`, body });
  }
  for (const { file, data } of readJsonFolder(join(root, 'exercises'))) {
    const { slug, ...body } = data;
    if (!slug) throw new Error(`exercises/${file}: missing "slug"`);
    steps.push({ label: `exercise ${slug}`, method: 'PUT', path: `/v1/admin/exercises/${slug}`, body });
  }
  for (const { file, data } of readJsonFolder(join(root, 'programs'))) {
    const { slug, ...body } = data;
    if (!slug) throw new Error(`programs/${file}: missing "slug"`);
    steps.push({ label: `program ${slug}`, method: 'PUT', path: `/v1/admin/programs/${slug}`, body });
    if (publish)
      steps.push({ label: `publish ${slug}`, method: 'POST', path: `/v1/admin/programs/${slug}/publish` });
  }
  return steps;
}

export async function runImport(steps, { base, key, fetcher = fetch, log = console.log }) {
  let failed = 0;
  for (const step of steps) {
    const res = await fetcher(base.replace(/\/$/, '') + step.path, {
      method: step.method,
      headers: { 'x-admin-key': key, ...(step.body ? { 'content-type': 'application/json' } : {}) },
      body: step.body ? JSON.stringify(step.body) : undefined,
    });
    if (res.ok) log(`ok    ${step.label}`);
    else {
      failed++;
      log(`FAIL  ${step.label}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    }
  }
  return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  const base = process.env.API_BASE;
  const key = process.env.ADMIN_API_KEY;
  if (!root || !base || !key) {
    console.error(
      'usage: API_BASE=https://... ADMIN_API_KEY=... node scripts/import-content.mjs <folder> [--publish]',
    );
    process.exit(1);
  }
  const steps = planImport(root, { publish: process.argv.includes('--publish') });
  console.log(`${steps.length} steps`);
  process.exit((await runImport(steps, { base, key })) ? 1 : 0);
}
