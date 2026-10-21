#!/usr/bin/env node
// Looks through the repository for things that must never be committed: API tokens, private keys, webhook URLs.
//
//   node scripts/secret-scan.mjs            scan the repository (exit 1 if anything looks like a secret)
//
// A real secret belongs in a GitHub environment secret (see docs/operations.md), never in a file. If a line is a harmless
// example that happens to look like one, add `scan:allow` to that line. If a real secret was ever committed, rotating it is the
// only fix: removing it from the latest commit does not remove it from history.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  ['Cloudflare API token', /\bcfut_[A-Za-z0-9_-]{30,}/],
  [
    'Cloudflare API token assigned in a file',
    /CLOUDFLARE_API_TOKEN\s*[=:]\s*['"]?(?!\$|\{|<|your|xxx|example)[A-Za-z0-9_-]{30,}/i,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ['Slack webhook URL', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['Discord webhook URL', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Resend API key', /\bre_[A-Za-z0-9]{24,}\b/],
  ['Stripe secret key', /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ['service account key id', /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/],
  [
    'secret-looking value assigned to a secret-looking name',
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*['"](?![^'"]*(?:test|example|fake|dummy|placeholder|changeme|xxxx))[A-Za-z0-9+/_=-]{32,}['"]/,
  ],
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'coverage', 'dist']);
const SKIP_FILES = new Set(['package-lock.json']);
const MAX_BYTES = 2 * 1024 * 1024;

/** Findings in one file's text. Pure. */
export function scanText(name, text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('scan:allow')) return;
    for (const [what, re] of RULES) if (re.test(line)) found.push({ file: name, line: i + 1, what });
  });
  return found;
}

export function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name) && !entry.name.endsWith('.rendered.jsonc')) {
      yield join(dir, entry.name);
    }
  }
}

export function scanRepo(root) {
  const found = [];
  for (const file of walk(root)) {
    if (statSync(file).size > MAX_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    found.push(...scanText(relative(root, file), buf.toString('utf8')));
  }
  // a stray environment file would hold real secrets even if its contents look harmless
  for (const name of ['.env', '.dev.vars'])
    if (existsSync(join(root, name)) && !isIgnored(root, name))
      found.push({ file: name, line: 0, what: 'environment file that is not git-ignored' });
  return found;
}

function isIgnored(root, name) {
  try {
    return readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .some((l) => l.trim() === name);
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found = scanRepo(root);
  if (found.length === 0) {
    console.log('secret scan: nothing found');
  } else {
    for (const f of found) console.error(`${f.file}:${f.line}  ${f.what}`);
    console.error(
      `\nsecret scan: ${found.length} possible secret(s). Remove them and rotate anything that was real.`,
    );
    process.exit(1);
  }
}
