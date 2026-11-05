#!/usr/bin/env node
// Partners (gyms) from GitHub Actions or a terminal: add one, list them, a month's statement, record a payout, stop a
// code. Talks to the admin API, so it needs the server's address and the admin key.
//
//   API_BASE=https://pango-api-stage.lightarch.io ADMIN_API_KEY=... node scripts/partners.mjs list
//   ... node scripts/partners.mjs create --name "Fit Hub Sandton" --code FITHUB [--share 20] [--months 12] [--welcome 200] [--contact "..."]
//   ... node scripts/partners.mjs report --code FITHUB --month 2026-11
//   ... node scripts/partners.mjs paid --code FITHUB --until 2026-12-01
//   ... node scripts/partners.mjs stop --code FITHUB
import { appendFileSync } from 'node:fs';

export const rand = (cents) =>
  `R${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The partners as a Markdown table. Pure. */
export function partnersTable(items) {
  const lines = [
    '| Partner | Code | Share | Members | On Plus | Earned | Owed | Running |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const p of items)
    lines.push(
      `| ${p.name} | ${p.code} | ${p.sharePct}% for ${p.months ? `${p.months} months` : 'as long as they pay'} | ${p.members} | ${p.plusMembers} | ${rand(p.earnedCents)} | ${rand(p.owedCents)} | ${p.active ? 'yes' : 'stopped'} |`,
    );
  if (!items.length) lines.push('| (none yet) | | | | | | | |');
  return lines.join('\n');
}

/** A month's statement as Markdown, ready to send to the partner. Pure. */
export function statement(r) {
  const lines = [
    `### ${r.partner.name} (${r.partner.code}), ${r.month}`,
    '',
    `New members this month: ${r.joined}. Share: ${r.partner.sharePct}% of each Plus payment, after VAT and Google Play's fee.`,
    '',
    '| Date | Plan | Price | Your share | |',
    '|---|---|---|---|---|',
  ];
  for (const p of r.payments)
    lines.push(
      `| ${new Date(p.at).toISOString().slice(0, 10)} | ${p.productId === 'pro_yearly' ? 'Yearly' : 'Monthly'} | ${rand(p.grossCents)} | ${rand(p.earningCents)} | ${p.refunded ? 'refunded' : p.paid ? 'paid out' : 'owed'} |`,
    );
  if (!r.payments.length) lines.push('| (no Plus payments this month) | | | | |');
  lines.push(
    '',
    `Earned this month: ${rand(r.totalEarningCents)}. Still to pay for this month: ${rand(r.unpaidCents)}.`,
  );
  return lines.join('\n');
}

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i];
  return { action, opts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = (process.env.API_BASE ?? '').replace(/\/$/, '');
  const key = process.env.ADMIN_API_KEY;
  if (!base || !key) {
    console.error('Set API_BASE and ADMIN_API_KEY');
    process.exit(1);
  }
  const call = async (method, path, data) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`${method} ${path}: HTTP ${res.status} ${out?.error?.message ?? ''}`);
      process.exit(1);
    }
    return out;
  };
  const { action, opts } = parseArgs(process.argv.slice(2));
  const byCode = async () => {
    const code = String(opts.code ?? '')
      .toUpperCase()
      .replace(/[\s-]/g, '');
    const p = (await call('GET', '/v1/admin/partners')).items.find((x) => x.code === code);
    if (!p) {
      console.error(`No partner with code ${code}`);
      process.exit(1);
    }
    return p;
  };
  let text;
  if (action === 'list') text = partnersTable((await call('GET', '/v1/admin/partners')).items);
  else if (action === 'create') {
    const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
    const p = await call('POST', '/v1/admin/partners', {
      name: opts.name,
      code: opts.code,
      sharePct: num(opts.share),
      months: num(opts.months),
      welcomePoints: num(opts.welcome),
      contact: opts.contact || null,
    });
    text =
      `Added ${p.name}: members enter **${p.code}** in the app (Me, then Pango Points) within 30 days of joining.\n\n` +
      partnersTable([p]);
  } else if (action === 'report') {
    const p = await byCode();
    const month = opts.month || new Date().toISOString().slice(0, 7);
    text = statement(await call('GET', `/v1/admin/partners/${p.id}/report?month=${month}`));
  } else if (action === 'paid') {
    const p = await byCode();
    const until = Date.parse(`${opts.until}T00:00:00Z`);
    if (Number.isNaN(until)) {
      console.error('--until must be a date like 2026-12-01');
      process.exit(1);
    }
    const r = await call('POST', `/v1/admin/partners/${p.id}/paid`, { until });
    text = `Marked ${r.rows} payments to ${p.name} as paid: ${rand(r.cents)}.`;
  } else if (action === 'stop') {
    const p = await byCode();
    await call('PATCH', `/v1/admin/partners/${p.id}`, { active: false });
    text = `Stopped ${p.code}: new people can no longer join with it. Existing members still earn ${p.name} its share.`;
  } else {
    console.error('Actions: list, create, report, paid, stop');
    process.exit(1);
  }
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
