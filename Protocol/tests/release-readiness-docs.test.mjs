import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

test('release runbook applies projection and wallet-history migrations in order', async () => {
  const [runbook, preflight] = await Promise.all([
    read('../docs/MAINNET_LAUNCH_RUNBOOK.md'),
    read('../scripts/check-mainnet-readiness.sh'),
  ]);
  const migrations = [
    '20260808133000_worker_schema_capabilities.sql',
    '20260808134500_round_projection_completeness.sql',
    '20260808135000_wallet_round_history.sql',
  ];
  const positions = migrations.map((name) => runbook.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));

  // server-claims-v1 remains a deliberate historical migration assertion;
  // round-projection-v2 is the final worker capability.
  assert.match(preflight, /20260808133000_worker_schema_capabilities\.sql[\s\S]*server-claims-v1/);
  assert.match(preflight, /20260808134500_round_projection_completeness\.sql[\s\S]*round-projection-v2/);
  assert.match(runbook, /earlier claim-vault schema[\s\S]*round-projection-v2/);
});

test('preflight covers projection completeness and wallet-scoped history boundaries', async () => {
  const preflight = await read('../scripts/check-mainnet-readiness.sh');
  assert.match(preflight, /projection_complete boolean not null default false/);
  assert.match(preflight, /mine_round_projection_digest/);
  assert.match(preflight, /enforce_mine_round_source_slot_monotonic/);
  assert.match(preflight, /cardinality\(p_round_ids\) > 50/);
  assert.match(preflight, /rounds\.projection_complete = true/);
  assert.match(preflight, /p_wallet: session\.walletAddress/);
  assert.match(preflight, /functions\.wallet-round-history/);
});

test('paused observe catch-up is an explicit prerequisite to live canaries', async () => {
  const [hosting, resilience, runbook] = await Promise.all([
    read('../docs/WORKER_HOSTING.md'),
    read('../docs/PRODUCTION_RESILIENCE.md'),
    read('../docs/MAINNET_LAUNCH_RUNBOOK.md'),
  ]);
  assert.match(hosting, /MYNE_WORKER_MODE=observe/);
  assert.match(hosting, /MYNE_WORKER_HOST_OBSERVE=D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e/);
  assert.match(hosting, /ROUND_INDEXER_PROJECT_ONLY=1/);
  assert.match(hosting, /starts exactly one[\s\S]*round-indexer/);
  assert.match(hosting, /protocolPaused: true/);
  assert.match(hosting, /historical-gaps:v1[\s\S]*full bounded pass/);
  assert.match(hosting, /projection_complete=true/);
  assert.match(hosting, /degradedWorkers[\s\S]*Railway does not restart healthy[\s\S]*claim workers/);
  assert.match(resilience, /two complete canary rounds \(one played, one empty\)/);
  assert.match(runbook, /ROUND_ACCOUNT_RETENTION_SECONDS=130/);
  assert.match(runbook, /current server commit-reveal mode[\s\S]*60-second betting interval/);
  assert.match(runbook, /If a future reviewed configuration selects Switchboard/);
});
