import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, BN, Program, setProvider } = anchor;
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = web3;
const {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} = splToken;

const GENESIS_BASE_UNITS = 100_000_000_000n;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

const idl = JSON.parse(
  await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'),
);
const programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  await readFile(new URL('../target/deploy/myne_protocol-keypair.json', import.meta.url), 'utf8'),
)));
const provider = AnchorProvider.env();
setProvider(provider);

const payer = provider.wallet.payer;
assert.ok(payer, 'The local test requires a file-backed Anchor wallet');
assert.match(provider.connection.rpcEndpoint, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/);

const program = new Program(idl, provider);
assert.ok(program.programId.equals(PROGRAM_ID), 'IDL and deployed program IDs differ');

const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [miningPool] = PublicKey.findProgramAddressSync([Buffer.from('mining_pool')], PROGRAM_ID);
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
const programAccount = await provider.connection.getAccountInfo(PROGRAM_ID, 'confirmed');
assert.ok(programAccount, 'The deployed program account is missing');
assert.ok(programAccount.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID));
// UpgradeableLoaderState::Program is a 4-byte enum tag followed by its ProgramData address.
const programData = new PublicKey(programAccount.data.subarray(4, 36));
const programDataAccount = await provider.connection.getAccountInfo(programData, 'confirmed');
assert.ok(programDataAccount, 'The deployed program is missing its ProgramData account');
assert.equal(programDataAccount.data[12], 1, 'The local program must remain upgradeable');
const deployedUpgradeAuthority = new PublicKey(programDataAccount.data.subarray(13, 45));
const upgradeAuthority = [payer, programKeypair]
  .find((candidate) => deployedUpgradeAuthority.equals(candidate.publicKey)) ?? null;
assert.ok(upgradeAuthority, `The local upgrade authority ${deployedUpgradeAuthority.toBase58()} is unavailable; known identities: ${[
  payer.publicKey,
  programKeypair.publicKey,
].map((key) => key.toBase58()).join(', ')}`);
const upgradeAuthoritySigners = upgradeAuthority.publicKey.equals(payer.publicKey)
  ? []
  : [upgradeAuthority];

const mint = await createMint(
  provider.connection,
  payer,
  payer.publicKey,
  null,
  9,
  undefined,
  undefined,
  TOKEN_PROGRAM_ID,
);
const launchAccount = await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  mint,
  payer.publicKey,
);
await mintTo(
  provider.connection,
  payer,
  mint,
  launchAccount.address,
  payer,
  GENESIS_BASE_UNITS,
);
await setAuthority(
  provider.connection,
  payer,
  mint,
  payer,
  AuthorityType.MintTokens,
  config,
);

const rogue = Keypair.generate();
const airdrop = await provider.connection.requestAirdrop(rogue.publicKey, LAMPORTS_PER_SOL);
await provider.connection.confirmTransaction(airdrop, 'confirmed');
const referrer = Keypair.generate();
const referrerAirdrop = await provider.connection.requestAirdrop(referrer.publicKey, LAMPORTS_PER_SOL);
await provider.connection.confirmTransaction(referrerAirdrop, 'confirmed');

const initializeAccounts = {
  config,
  miningPool,
  stakePool,
  payer: payer.publicKey,
  program: PROGRAM_ID,
  programData,
  mint,
  tokenProgram: TOKEN_PROGRAM_ID,
  systemProgram: SystemProgram.programId,
};

await assert.rejects(
  program.methods
    .initializeProtocol({
      randomnessAuthority: payer.publicKey,
      buybackWallet: payer.publicKey,
      motherlodeWallet: payer.publicKey,
      adminFeeWallet: payer.publicKey,
    })
    .accounts({ ...initializeAccounts, upgradeAuthority: rogue.publicKey })
    .signers([rogue])
    .rpc(),
  /InvalidUpgradeAuthority|upgrade authority|custom program error/i,
);

const initializeSignature = await program.methods
  .initializeProtocol({
    randomnessAuthority: payer.publicKey,
    buybackWallet: payer.publicKey,
    motherlodeWallet: payer.publicKey,
    adminFeeWallet: payer.publicKey,
  })
  .accounts({ ...initializeAccounts, upgradeAuthority: upgradeAuthority.publicKey })
  .signers(upgradeAuthoritySigners)
  .rpc();

// The local test uses the freshly-created mint as a non-empty token-account stand-in. This
// exercises the same immutable address/owner gate used for Meteora without pretending a system
// account is a liquidity pool (system-owned zero-filled accounts report empty data on localnet).
const localPool = mint;
await program.methods
  .initializeLiquidityGate(localPool, TOKEN_PROGRAM_ID, new BN(1), new BN(1))
  .accounts({ config, liquidityGate, pool: localPool, admin: upgradeAuthority.publicKey, systemProgram: SystemProgram.programId })
  .signers(upgradeAuthoritySigners)
  .rpc();

let state = await program.account.protocolConfig.fetch(config);
assert.equal(state.version, 3);
assert.equal(state.paused, true);
assert.ok(state.admin.equals(upgradeAuthority.publicKey));
assert.ok(state.mint.equals(mint));
assert.equal(state.genesisTokens.toString(), '100');
assert.equal(state.maxTokens.toString(), '2000000');
assert.equal(state.minimumRoundLamports.toString(), '50000000');
assert.equal(state.roundDurationSeconds.toString(), '65');
assert.equal(state.bettingDurationSeconds.toString(), '60');
assert.equal(state.unstakeDelaySeconds.toString(), '2592000');

await program.methods
  .setPaused(false)
  .accounts({ config, liquidityGate, liquidityPool: localPool, admin: upgradeAuthority.publicKey })
  .signers(upgradeAuthoritySigners)
  .rpc();

const [miner] = PublicKey.findProgramAddressSync(
  [Buffer.from('miner'), payer.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [stakePosition] = PublicKey.findProgramAddressSync(
  [Buffer.from('stake_position'), payer.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [referrerMiner] = PublicKey.findProgramAddressSync(
  [Buffer.from('miner'), referrer.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [referrerStakePosition] = PublicKey.findProgramAddressSync(
  [Buffer.from('stake_position'), referrer.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [rogueMiner] = PublicKey.findProgramAddressSync(
  [Buffer.from('miner'), rogue.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [rogueStakePosition] = PublicKey.findProgramAddressSync(
  [Buffer.from('stake_position'), rogue.publicKey.toBuffer()],
  PROGRAM_ID,
);
await program.methods
  .registerMiner(PublicKey.default)
  .accounts({
    config, miningPool, stakePool, miner: referrerMiner, stakePosition: referrerStakePosition,
    referrerMiner: null, authority: referrer.publicKey, systemProgram: SystemProgram.programId,
  })
  .signers([referrer])
  .rpc();
await program.methods
  .registerMiner(referrer.publicKey)
  .accounts({
    config,
    miningPool,
    stakePool,
    miner,
    stakePosition,
    referrerMiner,
    authority: payer.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
await program.methods
  .registerMiner(PublicKey.default)
  .accounts({
    config, miningPool, stakePool, miner: rogueMiner, stakePosition: rogueStakePosition,
    referrerMiner: null, authority: rogue.publicKey, systemProgram: SystemProgram.programId,
  })
  .signers([rogue])
  .rpc();

const stakeVault = await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  mint,
  stakePool,
  true,
);
await program.methods
  .stakeStandard(new BN('10000000000'))
  .accounts({
    config,
    stakePool,
    stakePosition,
    ownerTokens: launchAccount.address,
    vaultTokens: stakeVault.address,
    mint,
    authority: payer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
await program.methods
  .fundStakingRewards(new BN('100000000'))
  .accounts({ stakePool, funder: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();

const roundId = new BN(0);
const u64Buffer = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value.toString()));
  return buffer;
};
// Do not probe a rejected `openRound` here: Anchor allocates an `init` PDA before
// the schedule guard runs, and a failed local transaction can leave that account
// allocated on the test validator. The schedule guard is covered by the program
// tests; this integration flow keeps the round state uncontaminated.
const [round] = PublicKey.findProgramAddressSync(
  [Buffer.from('round'), u64Buffer(roundId)],
  PROGRAM_ID,
);
await program.methods
  .openRound(roundId)
  .accounts({ config, round, payer: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();

const amounts = Array.from({ length: 25 }, (_, index) => new BN(index === 0 ? 50_000_000 : 0));
const receiptFor = (authority, nonce) => PublicKey.findProgramAddressSync([
  Buffer.from('bet'),
  u64Buffer(roundId),
  authority.toBuffer(),
  u64Buffer(nonce),
], PROGRAM_ID)[0];
for (const nonce of [new BN(10), new BN(11)]) {
  await program.methods
    .deploy(roundId, nonce, amounts)
    .accounts({ config, miner, round, receipt: receiptFor(payer.publicKey, nonce), authority: payer.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
}
const rogueAmounts = Array.from({ length: 25 }, (_, index) => new BN(index === 0 ? 50_000_000 : 0));
await program.methods
  .deploy(roundId, new BN(20), rogueAmounts)
  .accounts({ config, miner: rogueMiner, round, receipt: receiptFor(rogue.publicKey, new BN(20)), authority: rogue.publicKey, systemProgram: SystemProgram.programId })
  .signers([rogue])
  .rpc();

const [autoPlan] = PublicKey.findProgramAddressSync(
  [Buffer.from('auto_plan'), payer.publicKey.toBuffer()],
  PROGRAM_ID,
);
await program.methods
  .createAutoPlan(amounts, new BN('100000000'))
  .accounts({ config, autoPlan, authority: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
await program.methods
  .executeAutoPlan(roundId, new BN(0))
  .accounts({ config, autoPlan, miner, round, receipt: receiptFor(payer.publicKey, new BN(0)), executor: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
await assert.rejects(
  program.methods
    .executeAutoPlan(roundId, new BN(1))
    .accounts({ config, autoPlan, miner, round, receipt: receiptFor(payer.publicKey, new BN(1)), executor: payer.publicKey, systemProgram: SystemProgram.programId })
    .rpc(),
  /AutoPlanAlreadyExecuted|already executed|custom program error/i,
);

let roundState = await program.account.round.fetch(round);
assert.equal(roundState.grossDeployedLamports.toString(), '200000000');
assert.equal(roundState.tileLamports[0].toString(), '200000000');
assert.equal(roundState.tileReceipts[0].toString(), '4');
assert.equal(Number(roundState.bettingEndsAt) - Number(roundState.openedAt), 60);
assert.equal(Number(roundState.settlesAt) - Number(roundState.bettingEndsAt), 0);
assert.equal(Number(roundState.refundAt) - Number(roundState.openedAt), 665);
await assert.rejects(
  program.methods
    .settleRound(Array(32).fill(1))
    .accounts({ config, stakePool, round, liquidityGate, liquidityPool: localPool, randomnessAuthority: payer.publicKey, buybackWallet: payer.publicKey })
    .rpc(),
  /RoundNotReady|not ready|custom program error/i,
);

// Localnet uses production timings. Wait for the real 60-second bidding boundary rather than
// adding a privileged test-only clock bypass that could accidentally survive into devnet.
const waitMs = Math.max(0, Number(roundState.settlesAt) * 1000 - Date.now() + 1_500);
await new Promise((resolve) => setTimeout(resolve, waitMs));
const domainHash = (domain, seed) => createHash('sha256')
  .update(Buffer.from('MYNE_V1'))
  .update(Buffer.from(domain))
  .update(u64Buffer(roundId))
  .update(Buffer.from(seed))
  .digest();
let randomness;
for (let value = 0; value < 100_000; value += 1) {
  const candidate = Buffer.alloc(32);
  candidate.writeUInt32LE(value);
  const tile = Number(domainHash('tile', candidate).readBigUInt64LE() % 25n);
  const solo = domainHash('mode', candidate).readBigUInt64LE() % 2n === 0n;
  if (tile === 0 && !solo) { randomness = [...candidate]; break; }
}
assert.ok(randomness, 'Failed to derive deterministic split-mode local randomness');
await program.methods
  .settleRound(randomness)
  .accounts({ config, stakePool, round, liquidityGate, liquidityPool: localPool, randomnessAuthority: payer.publicKey, buybackWallet: payer.publicKey })
  .rpc();
for (const nonce of [new BN(10), new BN(11), new BN(0)]) {
  await program.methods
    .claimReceipt()
    .accounts({ config, miningPool, stakePool, miner, stakePosition, round, receipt: receiptFor(payer.publicKey, nonce), authority: payer.publicKey })
    .rpc();
}
await program.methods
  .claimReceipt()
  .accounts({
    config, miningPool, stakePool, miner: rogueMiner, stakePosition: rogueStakePosition, round,
    receipt: receiptFor(rogue.publicKey, new BN(20)), authority: rogue.publicKey,
  })
  .signers([rogue])
  .rpc();
roundState = await program.account.round.fetch(round);
assert.equal(roundState.settled, true);
assert.equal(roundState.winningTile, 0);
assert.equal(roundState.soloMode, false);
assert.equal(roundState.motherlodePayoutLamports.toString(), '0');
assert.equal(roundState.claimedLamports.toString(), '176000000');
const settledConfig = await program.account.protocolConfig.fetch(config);
assert.equal(settledConfig.motherlodeLamports.toString(), '2000000');
let minerState = await program.account.miner.fetch(miner);
const referrerStateBefore = await program.account.miner.fetch(referrerMiner);
const payerGross = BigInt(minerState.unclaimedMyne.toString());
const payerReferral = (payerGross * 1_000n) / 10_000n - (payerGross * 900n) / 10_000n;
await program.methods
  .claimMyne()
  .accounts({
    config, miningPool, miner, referrerMiner, destinationTokens: launchAccount.address,
    adminFeeTokens: launchAccount.address, mint, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
minerState = await program.account.miner.fetch(miner);
assert.equal(minerState.unclaimedMyne.toString(), '0');
const referrerStateAfter = await program.account.miner.fetch(referrerMiner);
assert.equal(
  BigInt(referrerStateAfter.unclaimedMyne.toString()) - BigInt(referrerStateBefore.unclaimedMyne.toString()),
  payerReferral,
  'A labelled referrer receives exactly 1% of the claimed gross amount',
);
const adminBalanceBeforeFallback = (await splToken.getAccount(provider.connection, launchAccount.address)).amount;
const rogueTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, rogue.publicKey);
const rogueState = await program.account.miner.fetch(rogueMiner);
const rogueGross = BigInt(rogueState.unclaimedMyne.toString());
const rogueAdminFee = (rogueGross * 1_000n) / 10_000n - (rogueGross * 900n) / 10_000n;
await program.methods
  .claimMyne()
  .accounts({
    config, miningPool, miner: rogueMiner, referrerMiner: null, destinationTokens: rogueTokens.address,
    adminFeeTokens: launchAccount.address, mint, authority: rogue.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([rogue])
  .rpc();
const adminBalanceAfterFallback = (await splToken.getAccount(provider.connection, launchAccount.address)).amount;
assert.equal(
  adminBalanceAfterFallback - adminBalanceBeforeFallback,
  rogueAdminFee,
  'An unlabelled claim sends the 1% share to the configured admin fee wallet',
);
const mintState = await splToken.getMint(provider.connection, mint);
assert.equal(
  mintState.supply,
  GENESIS_BASE_UNITS + (payerGross - payerGross / 10n) + (rogueGross - rogueGross / 10n) + rogueAdminFee,
);

await program.methods
  .claimStakingRewards()
  .accounts({ stakePool, stakePosition, authority: payer.publicKey })
  .rpc();
const stakePoolState = await program.account.stakePool.fetch(stakePool);
assert.equal(stakePoolState.totalFundedLamports.toString(), '110500000');
assert.equal(stakePoolState.totalClaimedLamports.toString(), '110500000');

await program.methods
  .proposeAdmin(rogue.publicKey)
  .accounts({ config, admin: upgradeAuthority.publicKey })
  .signers(upgradeAuthoritySigners)
  .rpc();
await program.methods
  .acceptAdmin()
  .accounts({ config, pendingAdmin: rogue.publicKey })
  .signers([rogue])
  .rpc();

await assert.rejects(
  program.methods
    .setPaused(true)
    .accounts({ config, admin: upgradeAuthority.publicKey })
    .signers(upgradeAuthoritySigners)
    .rpc(),
  /ConstraintHasOne|has one|custom program error/i,
);
await program.methods
  .setPaused(true)
  .accounts({ config, admin: rogue.publicKey })
  .signers([rogue])
  .rpc();

state = await program.account.protocolConfig.fetch(config);
assert.equal(state.paused, true);
assert.ok(state.admin.equals(rogue.publicKey));
assert.ok(state.pendingAdmin.equals(PublicKey.default));

// Leave a detached validator usable by the local keeper after the authorization assertions.
await program.methods
  .setPaused(false)
  .accounts({ config, liquidityGate, liquidityPool: localPool, admin: rogue.publicKey })
  .signers([rogue])
  .rpc();
await program.methods
  .proposeAdmin(upgradeAuthority.publicKey)
  .accounts({ config, admin: rogue.publicKey })
  .signers([rogue])
  .rpc();
await program.methods
  .acceptAdmin()
  .accounts({ config, pendingAdmin: upgradeAuthority.publicKey })
  .signers(upgradeAuthoritySigners)
  .rpc();

state = await program.account.protocolConfig.fetch(config);
assert.equal(state.paused, false);
assert.ok(state.admin.equals(upgradeAuthority.publicKey));

console.log(JSON.stringify({
  ok: true,
  cluster: provider.connection.rpcEndpoint,
  programId: PROGRAM_ID.toBase58(),
  config: config.toBase58(),
  mint: mint.toBase58(),
  initializeSignature,
  tests: [
    'upgrade-authority-only initialization',
    'validated 100 MYNE genesis mint',
    'immutable launch economics',
    'admin pause authorization',
    'two-step admin transfer',
    'receipt-based mining with multiple unbounded deployments',
    'deterministic round schedule rejects premature future rounds',
    'constant-cost split settlement and per-receipt claims',
    'standard staking plus operator and mining-funded SOL rewards',
    '10% MYNE claim fee accounting and capped minting',
    'balance-capped auto-round execution without a play-count cap',
  ],
}, null, 2));
