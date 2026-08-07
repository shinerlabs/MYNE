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
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SWITCHBOARD_DEVNET_PROGRAM = new PublicKey('Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2');
const idl = JSON.parse(
  await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'),
);

const provider = AnchorProvider.env();
setProvider(provider);
const genesisHash = await provider.connection.getGenesisHash();
assert.equal(genesisHash, DEVNET_GENESIS_HASH, 'Use this smoke test only against Solana Devnet');

const program = new Program(idl, provider);
assert.ok(program.programId.equals(PROGRAM_ID), 'IDL and configured program IDs differ');
const instructions = new Map(idl.instructions.map((instruction) => [instruction.name, instruction]));
assert.ok(instructions.has('record_round_randomness_commit'), 'Devnet IDL lacks the post-close randomness commit callback');
for (const instructionName of ['deploy', 'execute_auto_plan']) {
  const accounts = new Set(instructions.get(instructionName)?.accounts.map((account) => account.name));
  assert.ok(accounts.has('randomness_account'), `${instructionName} does not require the bound randomness account`);
}
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
assert.equal(
  Number(state.version),
  6,
  `Devnet runs state version ${Number(state.version)}; run the guarded v5 -> v6 migration or initialize fresh v6 state`,
);
assert.ok(state.paused, 'Devnet version 6 must remain paused during the pre-activation smoke test');
assert.ok(state.randomnessProgram.equals(SWITCHBOARD_DEVNET_PROGRAM), 'Devnet config is not pinned to Switchboard Devnet');
assert.ok(!state.adminFeeWallet.equals(PublicKey.default), 'Admin fee wallet cannot be the default key');
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
  cluster: 'devnet',
  genesisHash,
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  miningPool: miningPool.toBase58(),
  stakePool: stakePool.toBase58(),
  admin: state.admin.toBase58(),
  adminFeeWallet: state.adminFeeWallet.toBase58(),
  mint: state.mint.toBase58(),
  status: 'paused',
}, null, 2));
