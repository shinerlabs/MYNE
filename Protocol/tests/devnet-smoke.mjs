import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const { PublicKey } = web3;
const { getMint } = splToken;

const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const GENESIS_BASE_UNITS = 100_000_000_000n;
const idl = JSON.parse(
  await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'),
);

const provider = AnchorProvider.env();
setProvider(provider);
assert.ok(!/127\.0\.0\.1|localhost/.test(provider.connection.rpcEndpoint), 'Use this smoke test only against devnet');

const program = new Program(idl, provider);
assert.ok(program.programId.equals(PROGRAM_ID), 'IDL and configured program IDs differ');
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const [programAccount, state, miningState, stakingState] = await Promise.all([
  provider.connection.getAccountInfo(PROGRAM_ID, 'confirmed'),
  program.account.protocolConfig.fetch(config),
  program.account.miningPool.fetch(miningPool),
  program.account.stakePool.fetch(stakePool),
]);
assert.ok(programAccount?.executable, 'Program is not executable on the selected cluster');
assert.ok(state.paused, 'Devnet configuration must remain paused after initialization');
assert.equal(state.version, 4);
assert.ok(BigInt(state.motherlodeLamports.toString()) >= 0n);
assert.equal(state.genesisTokens.toString(), '100');
assert.equal(state.maxTokens.toString(), '2000000');
assert.equal(state.minimumRoundLamports.toString(), '50000000');
assert.equal(state.roundDurationSeconds.toString(), '65');
assert.equal(state.bettingDurationSeconds.toString(), '60');
assert.equal(state.unstakeDelaySeconds.toString(), '2592000');
assert.equal(miningState.totalUnclaimed.toString(), '0');
assert.equal(stakingState.totalStandard.toString(), '0');
assert.equal(stakingState.totalBurn.toString(), '0');
assert.equal(stakingState.totalWeight.toString(), '0');
assert.equal(stakingState.totalFundedLamports.toString(), '0');

const mint = await getMint(provider.connection, state.mint, 'confirmed', TOKEN_PROGRAM_ID);
assert.equal(mint.decimals, 9);
assert.equal(mint.supply, GENESIS_BASE_UNITS);
assert.ok(mint.mintAuthority?.equals(config), 'Config PDA is not mint authority');
assert.equal(mint.freezeAuthority, null);

console.log(JSON.stringify({
  ok: true,
  cluster: provider.connection.rpcEndpoint,
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  miningPool: miningPool.toBase58(),
  stakePool: stakePool.toBase58(),
  admin: state.admin.toBase58(),
  mint: state.mint.toBase58(),
  status: 'paused',
}, null, 2));
