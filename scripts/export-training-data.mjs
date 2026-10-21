#!/usr/bin/env node
// Downloads the photos people chose to contribute and writes them as a training folder for the model
// (the `--extra-data` format of the calorie-model repo: an index.csv plus img/).
//
//   API_BASE=https://api.example.com ADMIN_API_KEY=... node scripts/export-training-data.mjs --out data/app_contrib [--since 1760000000000]
//
// What goes in, and why
//   * Photos the person CORRECTED (outcome "edited") become labelled training photos at a low weight (default 0.3): their numbers
//     are a person's estimate, not a measurement.
//   * Photos the person just ACCEPTED are left out by default. The label would be the model's own guess, so training on it teaches the
//     model its own mistakes. `--include-accepted` adds them at weight 0.1.
//   * Photos marked "not food" go to <out>/not_food/ (a list of negatives for the food / not-food output), never into index.csv.
//   * Discarded scans have no label and are skipped.
//   * People, not photos, are split into train and test: all of one person's photos land on the same side.
// Photos arrive without GPS or device details (the API strips them on upload). The folder is raw data about real people who agreed
// to help: keep it private, off shared drives and out of git, and delete a photo from it if the person later withdraws consent
// (re-running with no --since regenerates the folder from the people who still consent).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLUMNS = [
  'path',
  'calories',
  'mass',
  'fat',
  'carb',
  'protein',
  'weight',
  'split',
  'dish_id',
  'source',
  'components',
];
export const SOURCE = 'app-contrib';

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Deterministic: a person always lands on the same side, whatever else is in the export. */
export function isTestDonor(donor, fraction) {
  const bucket = parseInt(createHash('sha1').update(donor).digest('hex').slice(0, 8), 16) / 0x100000000;
  return bucket < fraction;
}

/** Decide what to do with one contribution: a training row, a negative example, or nothing. Pure. */
export function classify(item, { includeAccepted = false, weight = 0.3, acceptedWeight = 0.1 } = {}) {
  if (item.kind === 'not_food') return { use: 'not_food' };
  if (item.kind !== 'food' || !item.label) return { use: 'skip', why: 'no label' };
  const l = item.label;
  if (l.calories === null && l.massG === null) return { use: 'skip', why: 'no usable number' };
  if (!l.edited && !includeAccepted) return { use: 'skip', why: 'accepted without change' };
  return { use: 'train', weight: l.edited ? weight : acceptedWeight };
}

const blank = (v) => (v === null || v === undefined ? '' : String(Math.round(v * 10) / 10));

export function trainRow(item, path, weight, testFraction) {
  const l = item.label;
  return {
    path,
    calories: blank(l.calories),
    mass: blank(l.massG),
    fat: blank(l.fatG),
    carb: blank(l.carbG),
    protein: blank(l.proteinG),
    weight: String(weight),
    split: isTestDonor(item.donor, testFraction) ? 'test' : '',
    dish_id: '',
    source: SOURCE,
    components: '',
  };
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
export const toCsv = (columns, rows) =>
  [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(String(r[c] ?? ''))).join(','))].join(
    '\n',
  ) + '\n';

export async function exportContributions({
  base,
  key,
  out,
  since = 0,
  testFraction = 0.1,
  fetcher = fetch,
  log = console.log,
  ...options
}) {
  const get = (path) => fetcher(base.replace(/\/$/, '') + path, { headers: { 'x-admin-key': key } });
  mkdirSync(join(out, 'img'), { recursive: true });
  mkdirSync(join(out, 'not_food', 'img'), { recursive: true });
  const train = [];
  const negatives = [];
  const stats = { listed: 0, train: 0, notFood: 0, skipped: 0, downloaded: 0, failed: 0, newest: since };
  let cursor = null;
  do {
    const res = await get(
      `/v1/admin/training/contributions?limit=100&since=${since}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (!res.ok) throw new Error(`listing failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    for (const item of page.items) {
      stats.listed++;
      stats.newest = Math.max(stats.newest, item.createdAt);
      const plan = classify(item, options);
      if (plan.use === 'skip') {
        stats.skipped++;
        continue;
      }
      const ext = EXTENSION[item.photoType] ?? 'jpg';
      const rel = `img/${item.id}.${ext}`;
      const file = join(out, plan.use === 'train' ? '' : 'not_food', rel);
      if (!existsSync(file)) {
        const photo = await get(`/v1/admin/training/contributions/${item.id}/photo`);
        if (!photo.ok) {
          stats.failed++; // withdrawn a moment ago, or removed: leave it out
          log(`skip  ${item.id}: HTTP ${photo.status}`);
          continue;
        }
        writeFileSync(file, Buffer.from(await photo.arrayBuffer()));
        stats.downloaded++;
      }
      if (plan.use === 'train') {
        train.push(trainRow(item, rel, plan.weight, testFraction));
        stats.train++;
      } else {
        negatives.push({
          path: rel,
          split: isTestDonor(item.donor, testFraction) ? 'test' : '',
          source: SOURCE,
        });
        stats.notFood++;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  writeFileSync(join(out, 'index.csv'), toCsv(COLUMNS, train));
  writeFileSync(join(out, 'not_food', 'index.csv'), toCsv(['path', 'split', 'source'], negatives));
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const out = flag('out');
  const base = process.env.API_BASE;
  const key = process.env.ADMIN_API_KEY;
  if (!out || !base || !key) {
    console.error(
      'usage: API_BASE=https://... ADMIN_API_KEY=... node scripts/export-training-data.mjs --out <folder> [--since <ms>] [--include-accepted] [--test-fraction 0.1] [--weight 0.3]',
    );
    process.exit(1);
  }
  const stats = await exportContributions({
    base,
    key,
    out,
    since: Number(flag('since') ?? 0),
    testFraction: Number(flag('test-fraction') ?? 0.1),
    weight: Number(flag('weight') ?? 0.3),
    includeAccepted: args.includes('--include-accepted'),
  });
  console.log(
    `${stats.listed} contributions: ${stats.train} for training, ${stats.notFood} not-food, ${stats.skipped} skipped, ${stats.failed} unavailable (${stats.downloaded} photos downloaded)`,
  );
  console.log(`next time, to fetch only new ones: --since ${stats.newest}`);
}
