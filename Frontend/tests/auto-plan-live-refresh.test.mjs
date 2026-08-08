import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('a confirmed Auto Mine execution refreshes the plan, tile receipts and wallet ledger together', async () => {
  const source = await readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8');
  const start = source.indexOf("subscribeAccountActivity(derivePda('auto_plan', authority)");
  const end = source.indexOf('\n    }),\n  ];', start);
  assert.ok(start >= 0 && end > start, 'Auto-plan account subscription must exist');
  const callback = source.slice(start, end);
  assert.match(callback, /Promise\.all\(\[refreshPlan\(\), refreshRound\(\), refreshMiner\(\)\]\)/);
  assert.match(callback, /document\.hidden/);
});
