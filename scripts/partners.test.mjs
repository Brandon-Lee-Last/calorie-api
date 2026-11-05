// The partner script's tables and statements. Plain Node, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, partnersTable, rand, statement } from './partners.mjs';

test('reads its arguments', () => {
  assert.deepEqual(parseArgs(['create', '--name', 'Fit Hub', '--code', 'FITHUB']), {
    action: 'create',
    opts: { name: 'Fit Hub', code: 'FITHUB' },
  });
});

test('shows money in rand and lays out partners and statements', () => {
  assert.match(rand(103550), /^R1.035,50$|^R1 035,50$|^R1 035,50$/);
  const t = partnersTable([
    {
      name: 'Fit Hub',
      code: 'FITHUB',
      sharePct: 20,
      months: 12,
      members: 4,
      plusMembers: 2,
      earnedCents: 2070,
      owedCents: 1035,
      active: true,
    },
  ]);
  assert.match(t, /\| Fit Hub \| FITHUB \| 20% for 12 months \| 4 \| 2 \| R20,70 \| R10,35 \| yes \|/);
  const s = statement({
    partner: { name: 'Fit Hub', code: 'FITHUB', sharePct: 20 },
    month: '2026-11',
    joined: 3,
    payments: [
      {
        at: Date.UTC(2026, 10, 2),
        productId: 'pro_monthly',
        grossCents: 6999,
        earningCents: 1035,
        refunded: false,
        paid: false,
      },
    ],
    totalEarningCents: 1035,
    unpaidCents: 1035,
  });
  assert.match(s, /New members this month: 3/);
  assert.match(s, /\| 2026-11-02 \| Monthly \| R69,99 \| R10,35 \| owed \|/);
});
