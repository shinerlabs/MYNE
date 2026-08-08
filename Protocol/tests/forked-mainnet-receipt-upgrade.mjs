import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const { PublicKey } = web3;

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const snapshot = JSON.parse(await readFile(
  new URL('./fixtures/mainnet-receipt-upgrade-snapshot.json', import.meta.url),
  'utf8',
));
assert.equal(snapshot.programId, PROGRAM_ID.toBase58());
const EXPECTED_RECEIPTS = snapshot.receipts.length;
const EXPECTED_SOL_LAMPORTS = BigInt(snapshot.expectedSolLamports);
const EXPECTED_MYNE_BASE_UNITS = BigInt(snapshot.expectedMyneBaseUnits);

const receiptAddresses = (process.argv.length > 2 ? process.argv.slice(2) : snapshot.receipts)
  .map((value) => new PublicKey(value));
assert.equal(receiptAddresses.length, EXPECTED_RECEIPTS, 'Expected the frozen set of 16 live receipts');

const provider = AnchorProvider.env();
assert.match(provider.connection.rpcEndpoint, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/);
setProvider(provider);
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const program = new Program(idl, provider);
assert.ok(program.programId.equals(PROGRAM_ID));

const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra],
  PROGRAM_ID,
)[0];
const u64Seed = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value?.toString?.() ?? value));
  return out;
};
const asBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const config = pda('config');
const miningPool = pda('mining_pool');
const stakePool = pda('stake_pool');

const configState = await program.account.protocolConfig.fetch(config);
assert.equal(Number(configState.version), 6);
assert.equal(configState.paused, true, 'The cloned production state must remain paused');

const beforeStakePoolInfo = await provider.connection.getAccountInfo(stakePool, 'confirmed');
const beforeMiningPool = await program.account.miningPool.fetch(miningPool);
assert.ok(beforeStakePoolInfo);
const initialBeneficiaryBalances = new Map();
const initialPending = new Map();
for (const receiptAddress of receiptAddresses) {
  const receipt = await program.account.betReceipt.fetch(receiptAddress);
  assert.equal(receipt.claimed, false);
  assert.equal(receipt.refunded, false);
  const authority = receipt.authority;
  const key = authority.toBase58();
  if (!initialBeneficiaryBalances.has(key)) {
    initialBeneficiaryBalances.set(key, await provider.connection.getBalance(authority, 'confirmed'));
    const position = await program.account.stakePosition.fetch(pda('stake_position', authority.toBuffer()));
    initialPending.set(key, asBig(position.pendingSol));
  }
}

for (const receiptAddress of receiptAddresses) {
  const receipt = await program.account.betReceipt.fetch(receiptAddress);
  const authority = receipt.authority;
  const round = pda('round', u64Seed(receipt.roundId));
  const miner = pda('miner', authority.toBuffer());
  const stakePosition = pda('stake_position', authority.toBuffer());
  await program.methods
    .settleReceipt()
    .accounts({
      config,
      miningPool,
      stakePool,
      miner,
      stakePosition,
      round,
      receipt: receiptAddress,
      beneficiary: authority,
      executor: provider.wallet.publicKey,
    })
    .rpc();
}

// Local validators can briefly return an account snapshot one transaction
// behind even after `.rpc()` confirms. Poll the two authoritative ledgers to
// the exact expected deltas instead of weakening the financial assertion.
let afterStakePoolInfo = null;
let afterMiningPool = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  [afterStakePoolInfo, afterMiningPool] = await Promise.all([
    provider.connection.getAccountInfo(stakePool, 'confirmed'),
    program.account.miningPool.fetch(miningPool),
  ]);
  const solReady = afterStakePoolInfo
    && BigInt(afterStakePoolInfo.lamports - beforeStakePoolInfo.lamports) === EXPECTED_SOL_LAMPORTS;
  const myneReady = asBig(afterMiningPool.totalUnclaimed) - asBig(beforeMiningPool.totalUnclaimed)
    === EXPECTED_MYNE_BASE_UNITS;
  if (solReady && myneReady) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(afterStakePoolInfo);
assert.equal(
  BigInt(afterStakePoolInfo.lamports - beforeStakePoolInfo.lamports),
  EXPECTED_SOL_LAMPORTS,
  'Every live SOL reward must move into the durable owner claim vault',
);
assert.equal(
  asBig(afterMiningPool.totalUnclaimed) - asBig(beforeMiningPool.totalUnclaimed),
  EXPECTED_MYNE_BASE_UNITS,
  'Every live unclaimed MYNE reward must remain attributed in the mining ledger',
);

let pendingIncrease = 0n;
for (const [authority, balanceBefore] of initialBeneficiaryBalances) {
  const key = new PublicKey(authority);
  assert.equal(
    await provider.connection.getBalance(key, 'confirmed'),
    balanceBefore,
    'Permissionless processing must not pay a beneficiary wallet directly',
  );
  const position = await program.account.stakePosition.fetch(pda('stake_position', key.toBuffer()));
  pendingIncrease += asBig(position.pendingSol) - initialPending.get(authority);
}
assert.ok(
  pendingIncrease >= EXPECTED_SOL_LAMPORTS,
  'Receipt SOL plus any already-funded staking accrual must be visible in owner claim balances',
);
const checkpointedStakingLamports = pendingIncrease - EXPECTED_SOL_LAMPORTS;

for (const receiptAddress of receiptAddresses) {
  const receipt = await program.account.betReceipt.fetch(receiptAddress);
  assert.equal(receipt.claimed, true);
  assert.equal(receipt.refunded, false);
}

console.log(JSON.stringify({
  ok: true,
  receipts: receiptAddresses.length,
  accruedSolLamports: EXPECTED_SOL_LAMPORTS.toString(),
  checkpointedStakingLamports: checkpointedStakingLamports.toString(),
  attributedMyneBaseUnits: EXPECTED_MYNE_BASE_UNITS.toString(),
  directWalletPayments: 0,
}));
