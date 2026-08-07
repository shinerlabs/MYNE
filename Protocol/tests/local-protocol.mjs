import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import * as splToken from '@solana/spl-token';
import web3 from '@solana/web3.js';

const { AnchorProvider, BN, EventParser, Program, setProvider } = anchor;
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
const miningShareValue = (pool, minerState) => {
  const assets = BigInt(pool.totalUnclaimed.toString());
  const shares = BigInt(pool.rewardPerUnclaimed.toString());
  const owned = BigInt(minerState.passiveRewardDebt.toString());
  if (owned === 0n || assets === 0n || shares === 0n || owned > shares) return 0n;
  return assets * owned / shares;
};

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
const rogue = Keypair.generate();
const airdrop = await provider.connection.requestAirdrop(rogue.publicKey, LAMPORTS_PER_SOL);
await provider.connection.confirmTransaction(airdrop, 'confirmed');
const fallbackOwner = Keypair.generate();
const fallbackAirdrop = await provider.connection.requestAirdrop(
  fallbackOwner.publicKey,
  LAMPORTS_PER_SOL,
);
await provider.connection.confirmTransaction(fallbackAirdrop, 'confirmed');
const buybackOwner = Keypair.generate();
const buybackAirdrop = await provider.connection.requestAirdrop(
  buybackOwner.publicKey,
  LAMPORTS_PER_SOL,
);
await provider.connection.confirmTransaction(buybackAirdrop, 'confirmed');
// The fallback path is constrained to this canonical ATA and remains distinct
// from the claimant's token account during the local aliasing checks.
const adminFeeAccount = (await getOrCreateAssociatedTokenAccount(
  provider.connection,
  payer,
  mint,
  fallbackOwner.publicKey,
  false,
)).address;
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

const referrer = Keypair.generate();
const referrerAirdrop = await provider.connection.requestAirdrop(referrer.publicKey, LAMPORTS_PER_SOL);
await provider.connection.confirmTransaction(referrerAirdrop, 'confirmed');
const loser = Keypair.generate();
const loserAirdrop = await provider.connection.requestAirdrop(loser.publicKey, LAMPORTS_PER_SOL);
await provider.connection.confirmTransaction(loserAirdrop, 'confirmed');

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
      randomnessProgram: PublicKey.default,
      buybackWallet: payer.publicKey,
      motherlodeWallet: payer.publicKey,
      adminFeeWallet: fallbackOwner.publicKey,
    })
    .accounts({ ...initializeAccounts, upgradeAuthority: rogue.publicKey })
    .signers([rogue])
    .rpc(),
  /InvalidUpgradeAuthority|upgrade authority|custom program error/i,
);

const initializeSignature = await program.methods
  .initializeProtocol({
    randomnessAuthority: payer.publicKey,
    randomnessProgram: PublicKey.default,
    buybackWallet: buybackOwner.publicKey,
    motherlodeWallet: payer.publicKey,
    adminFeeWallet: fallbackOwner.publicKey,
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
  .accounts({
    config,
    liquidityGate,
    pool: localPool,
    baseVault: null,
    quoteVault: null,
    admin: upgradeAuthority.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .signers(upgradeAuthoritySigners)
  .rpc();

let state = await program.account.protocolConfig.fetch(config);
assert.equal(state.version, 6);
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
  .accounts({
    config,
    liquidityGate,
    liquidityPool: localPool,
    baseVault: null,
    quoteVault: null,
    admin: upgradeAuthority.publicKey,
  })
  .signers(upgradeAuthoritySigners)
  .rpc();
await assert.rejects(
  program.methods
    .migrateFeeScheduleV6()
    .accounts({
      config,
      liquidityGate: null,
      liquidityPool: null,
      admin: upgradeAuthority.publicKey,
    })
    .signers(upgradeAuthoritySigners)
    .rpc(),
  /MigrationRequiresPause|Pause the protocol|custom program error/i,
);

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
const [loserMiner] = PublicKey.findProgramAddressSync(
  [Buffer.from('miner'), loser.publicKey.toBuffer()],
  PROGRAM_ID,
);
const [loserStakePosition] = PublicKey.findProgramAddressSync(
  [Buffer.from('stake_position'), loser.publicKey.toBuffer()],
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
await program.methods
  .registerMiner(PublicKey.default)
  .accounts({
    config, miningPool, stakePool, miner: loserMiner, stakePosition: loserStakePosition,
    referrerMiner: null, authority: loser.publicKey, systemProgram: SystemProgram.programId,
  })
  .signers([loser])
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
const ninetyPercentShare = Array.from({ length: 25 }, (_, index) => new BN(index === 0 ? 450_000_000 : 0));
const tenPercentShare = Array.from({ length: 25 }, (_, index) => new BN(index === 0 ? 50_000_000 : 0));
const receiptFor = (authority, nonce) => PublicKey.findProgramAddressSync([
  Buffer.from('bet'),
  u64Buffer(roundId),
  authority.toBuffer(),
  u64Buffer(nonce),
], PROGRAM_ID)[0];
await program.methods
  .deploy(roundId, new BN(10), ninetyPercentShare)
  .accounts({ config, miner, round, receipt: receiptFor(payer.publicKey, new BN(10)), randomnessAccount: null, authority: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
await program.methods
  .deploy(roundId, new BN(11), tenPercentShare)
  .accounts({ config, miner, round, receipt: receiptFor(payer.publicKey, new BN(11)), randomnessAccount: null, authority: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
const rogueAmounts = Array.from({ length: 25 }, (_, index) => new BN(index === 0 ? 50_000_000 : 0));
await program.methods
  .deploy(roundId, new BN(20), rogueAmounts)
  .accounts({ config, miner: rogueMiner, round, receipt: receiptFor(rogue.publicKey, new BN(20)), randomnessAccount: null, authority: rogue.publicKey, systemProgram: SystemProgram.programId })
  .signers([rogue])
  .rpc();
const losingAmounts = Array.from({ length: 25 }, (_, index) => new BN(index === 1 ? 50_000_000 : 0));
await program.methods
  .deploy(roundId, new BN(30), losingAmounts)
  .accounts({
    config, miner: loserMiner, round, receipt: receiptFor(loser.publicKey, new BN(30)),
    randomnessAccount: null, authority: loser.publicKey, systemProgram: SystemProgram.programId,
  })
  .signers([loser])
  .rpc();

const [autoPlan] = PublicKey.findProgramAddressSync(
  [Buffer.from('auto_plan'), payer.publicKey.toBuffer()],
  PROGRAM_ID,
);
await program.methods
  .createAutoPlan(amounts, new BN('100000000'), 1)
  .accounts({ config, autoPlan, authority: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
await program.methods
  .executeAutoPlan(roundId, new BN(0))
  .accounts({ config, autoPlan, miner, round, receipt: receiptFor(payer.publicKey, new BN(0)), randomnessAccount: null, executor: payer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
await assert.rejects(
  program.methods
    .executeAutoPlan(roundId, new BN(1))
    .accounts({ config, autoPlan, miner, round, receipt: receiptFor(payer.publicKey, new BN(1)), randomnessAccount: null, executor: payer.publicKey, systemProgram: SystemProgram.programId })
    .rpc(),
  /AutoPlanAlreadyExecuted|already executed|custom program error/i,
);

let roundState = await program.account.round.fetch(round);
assert.equal(roundState.grossDeployedLamports.toString(), '650000000');
assert.equal(roundState.tileLamports[0].toString(), '600000000');
assert.equal(roundState.tileReceipts[0].toString(), '4');
assert.equal(Number(roundState.bettingEndsAt) - Number(roundState.openedAt), 60);
assert.equal(Number(roundState.settlesAt) - Number(roundState.bettingEndsAt), 0);
assert.equal(Number(roundState.refundAt) - Number(roundState.openedAt), 665);
// The legacy byte-array settlement instruction is intentionally available only when no
// production randomness provider is configured. It is used here to keep the local suite fast;
// Switchboard-backed configurations must use settleRoundVerified after the scheduled boundary.
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
  const motherlode = domainHash('motherlode', candidate).readBigUInt64LE() % 650n === 0n;
  if (tile === 0 && !solo && !motherlode) { randomness = [...candidate]; break; }
}
assert.ok(randomness, 'Failed to derive deterministic split-mode local randomness');
await assert.rejects(
  program.methods
    .settleRound(randomness)
    .accounts({
      config,
      stakePool,
      round,
      liquidityGate,
      liquidityPool: localPool,
      randomnessAuthority: payer.publicKey,
      buybackWallet: buybackOwner.publicKey,
      adminFeeWallet: rogue.publicKey,
    })
    .rpc(),
  /InvalidFeeDestination|fee destination|custom program error/i,
);
const adminSolBeforeSettlement = await provider.connection.getBalance(fallbackOwner.publicKey, 'confirmed');
const buybackSolBeforeSettlement = await provider.connection.getBalance(buybackOwner.publicKey, 'confirmed');
const stakePoolBeforeSettlement = await program.account.stakePool.fetch(stakePool);
const settlementSignature = await program.methods
  .settleRound(randomness)
  .accounts({
    config,
    stakePool,
    round,
    liquidityGate,
    liquidityPool: localPool,
    randomnessAuthority: payer.publicKey,
    buybackWallet: buybackOwner.publicKey,
    adminFeeWallet: fallbackOwner.publicKey,
  })
  .rpc();
await provider.connection.confirmTransaction(settlementSignature, 'confirmed');
const adminSolAfterSettlement = await provider.connection.getBalance(fallbackOwner.publicKey, 'confirmed');
const buybackSolAfterSettlement = await provider.connection.getBalance(buybackOwner.publicKey, 'confirmed');
const stakePoolAfterSettlement = await program.account.stakePool.fetch(stakePool);
roundState = await program.account.round.fetch(round);
assert.equal(roundState.prizeLamports.toString(), '572000000', 'Exactly 88% remains for miners');
assert.equal(
  adminSolAfterSettlement - adminSolBeforeSettlement,
  11_700_000,
  'Admin receives 1% of round volume plus 10% of the gross 8% staking allocation directly',
);
assert.equal(
  buybackSolAfterSettlement - buybackSolBeforeSettlement,
  6_500_000,
  'Exactly 1% of round volume is transferred directly to the buyback wallet',
);
assert.equal(
  BigInt(stakePoolAfterSettlement.totalFundedLamports.toString())
    - BigInt(stakePoolBeforeSettlement.totalFundedLamports.toString()),
  46_800_000n,
  'Stakers receive the net 7.2% round allocation after the 10% staking admin share',
);
const settlementTransaction = await provider.connection.getTransaction(settlementSignature, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0,
});
assert.ok(settlementTransaction?.meta?.logMessages, 'Settlement logs are unavailable');
const settlementEvents = [...new EventParser(PROGRAM_ID, program.coder)
  .parseLogs(settlementTransaction.meta.logMessages)];
const feeEvent = settlementEvents.find(({ name }) => (
  name === 'RoundFeesDistributed' || name === 'roundFeesDistributed'
))?.data;
assert.ok(
  feeEvent,
  `Settlement must emit the canonical fee audit event; decoded: ${settlementEvents
    .map(({ name }) => name)
    .join(', ') || 'none'}`,
);
assert.equal(feeEvent.grossDeployedLamports.toString(), '650000000');
assert.equal(feeEvent.totalFeeLamports.toString(), '78000000');
assert.equal(feeEvent.stakingGrossLamports.toString(), '52000000');
assert.equal(feeEvent.stakingAdminLamports.toString(), '5200000');
assert.equal(feeEvent.stakingNetLamports.toString(), '46800000');
assert.equal(feeEvent.buybackLamports.toString(), '6500000');
assert.equal(feeEvent.motherlodeLamports.toString(), '13000000');
assert.equal(feeEvent.miningAdminLamports.toString(), '6500000');
assert.equal(feeEvent.adminTotalLamports.toString(), '11700000');
assert.ok(feeEvent.adminFeeWallet.equals(fallbackOwner.publicKey));
for (const nonce of [new BN(10), new BN(11)]) {
  await program.methods
    .claimReceipt()
    .accounts({ config, miningPool, stakePool, miner, stakePosition, round, receipt: receiptFor(payer.publicKey, nonce), authority: payer.publicKey })
    .rpc();
}
const stakePoolBeforeAutoBurn = await program.account.stakePool.fetch(stakePool);
const positionBeforeAutoBurn = await program.account.stakePosition.fetch(stakePosition);
await program.methods
  .claimAutoBurnReceipt()
  .accounts({
    config, miningPool, stakePool, miner, stakePosition, round,
    receipt: receiptFor(payer.publicKey, new BN(0)), beneficiary: payer.publicKey,
    executor: payer.publicKey,
  })
  .rpc();
await assert.rejects(
  program.methods
    .settleReceipt()
    .accounts({
      config, miningPool, stakePool, miner: rogueMiner, stakePosition: rogueStakePosition, round,
      receipt: receiptFor(rogue.publicKey, new BN(20)), beneficiary: loser.publicKey,
      executor: payer.publicKey,
    })
    .rpc(),
  /InvalidReceiptAuthority|receipt authority|custom program error/i,
);
await program.methods
  .settleReceipt()
  .accounts({
    config, miningPool, stakePool, miner: rogueMiner, stakePosition: rogueStakePosition, round,
    receipt: receiptFor(rogue.publicKey, new BN(20)), beneficiary: rogue.publicKey,
    executor: payer.publicKey,
  })
  .rpc();
await assert.rejects(
  program.methods
    .archiveRound([...Buffer.alloc(32, 7)])
    .accounts({ config, round, randomnessAuthority: payer.publicKey })
    .rpc(),
  /RoundCleanupIncomplete|cleanup incomplete|custom program error/i,
);
await program.methods
  .settleReceipt()
  .accounts({
    config, miningPool, stakePool, miner: loserMiner, stakePosition: loserStakePosition, round,
    receipt: receiptFor(loser.publicKey, new BN(30)), beneficiary: loser.publicKey,
    executor: payer.publicKey,
  })
  .rpc();
roundState = await program.account.round.fetch(round);
assert.equal(roundState.settled, true);
assert.equal(roundState.winningTile, 0);
assert.equal(roundState.soloMode, false);
assert.equal(roundState.motherlodePayoutLamports.toString(), '0');
assert.equal(roundState.claimedLamports.toString(), '572000000');
assert.equal(roundState.totalReceipts.toString(), '5');
assert.equal(roundState.processedReceipts.toString(), '5');
assert.equal(roundState.closedReceipts.toString(), '0');
assert.equal(roundState.buybackCompleted, true);
const settledConfig = await program.account.protocolConfig.fetch(config);
assert.equal(settledConfig.motherlodeLamports.toString(), '13000000');
const autoBurnPosition = await program.account.stakePosition.fetch(stakePosition);
const stakePoolAfterAutoBurn = await program.account.stakePool.fetch(stakePool);
const autoBurnPrincipalDelta = BigInt(autoBurnPosition.burnPrincipal.toString())
  - BigInt(positionBeforeAutoBurn.burnPrincipal.toString());
const poolBurnDelta = BigInt(stakePoolAfterAutoBurn.totalBurn.toString())
  - BigInt(stakePoolBeforeAutoBurn.totalBurn.toString());
const poolWeightDelta = BigInt(stakePoolAfterAutoBurn.totalWeight.toString())
  - BigInt(stakePoolBeforeAutoBurn.totalWeight.toString());
const totalStakedBeforeAutoBurn = BigInt(stakePoolBeforeAutoBurn.totalStandard.toString())
  + BigInt(stakePoolBeforeAutoBurn.totalBurn.toString());
const totalStakedAfterAutoBurn = BigInt(stakePoolAfterAutoBurn.totalStandard.toString())
  + BigInt(stakePoolAfterAutoBurn.totalBurn.toString());
assert.equal(autoBurnPosition.burnPrincipal.toString(), '83333334');
assert.equal(autoBurnPosition.rewardWeight.toString(), '10416666670');
assert.equal(poolBurnDelta, autoBurnPrincipalDelta, 'Auto-burn must increase pool and position burn principal equally');
assert.equal(poolWeightDelta, autoBurnPrincipalDelta * 5n, 'Auto-burn must add exactly 5x pool weight');
assert.equal(
  totalStakedAfterAutoBurn - totalStakedBeforeAutoBurn,
  autoBurnPrincipalDelta,
  'Total staked must include both standard and permanent burn stake',
);
const autoReceipt = await program.account.betReceipt.fetch(receiptFor(payer.publicKey, new BN(0)));
assert.equal(autoReceipt.rewardMode, 1);
assert.equal(autoReceipt.claimed, true);
let minerState = await program.account.miner.fetch(miner);
const rogueRewardState = await program.account.miner.fetch(rogueMiner);
const loserRewardState = await program.account.miner.fetch(loserMiner);
assert.equal(minerState.lifetimeSolClaimed.toString(), '524333333');
assert.equal(rogueRewardState.lifetimeSolClaimed.toString(), '47666667');
assert.equal(loserRewardState.lifetimeSolClaimed.toString(), '0');
const referrerStateBefore = await program.account.miner.fetch(referrerMiner);
const poolBeforeReferredClaim = await program.account.miningPool.fetch(miningPool);
const payerGross = miningShareValue(poolBeforeReferredClaim, minerState);
const payerReferral = (payerGross * 1_000n) / 10_000n - (payerGross * 900n) / 10_000n;
const adminBalanceBeforeReferredClaim = (await splToken.getAccount(provider.connection, adminFeeAccount)).amount;
await program.methods
  .claimMyne()
  .accounts({
    config, miningPool, miner, referrerMiner, destinationTokens: launchAccount.address,
    adminFeeTokens: null, mint, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
minerState = await program.account.miner.fetch(miner);
assert.equal(minerState.unclaimedMyne.toString(), '0');
const referrerStateAfter = await program.account.miner.fetch(referrerMiner);
const poolAfterReferredClaim = await program.account.miningPool.fetch(miningPool);
const referrerValueBefore = miningShareValue(poolBeforeReferredClaim, referrerStateBefore);
const referrerValueAfter = miningShareValue(poolAfterReferredClaim, referrerStateAfter);
assert.equal(
  BigInt(referrerStateAfter.unclaimedMyne.toString()),
  referrerValueAfter,
  'The referrer cache equals its exact post-claim share value',
);
assert.equal(referrerValueBefore, 0n, 'The first referral credit starts without earlier pool shares');
assert.ok(
  referrerValueAfter <= payerReferral && referrerValueAfter + 1n >= payerReferral,
  'The referrer receives the 1% asset credit within one base unit of share-rounding precision',
);
assert.equal(
  BigInt(poolAfterReferredClaim.totalUnclaimed.toString()),
  BigInt(poolBeforeReferredClaim.totalUnclaimed.toString())
    - payerGross
    + (payerGross * 900n) / 10_000n
    + payerReferral,
  'Claim, passive distribution and referral credit conserve every pool asset unit',
);
assert.equal(
  (await splToken.getAccount(provider.connection, adminFeeAccount)).amount,
  adminBalanceBeforeReferredClaim,
  'A labelled referral must not also pay the administrator fallback',
);

// The Rewards panel's 0% Stake + Burn action must not mint liquid MYNE or route through the
// 10% claim-fee path. It checkpoints passive rewards, consumes the complete unclaimed balance,
// and records the same permanent 5x virtual stake used by Auto-burn.
const referrerPositionBeforeBurn = await program.account.stakePosition.fetch(referrerStakePosition);
const referrerMinerBeforeBurn = await program.account.miner.fetch(referrerMiner);
const poolBeforeBurn = await program.account.miningPool.fetch(miningPool);
const referrerBurnAmount = miningShareValue(poolBeforeBurn, referrerMinerBeforeBurn);
const supplyBeforeRewardBurn = (await splToken.getMint(provider.connection, mint)).supply;
await program.methods
  .burnUnclaimedMyne()
  .accounts({
    config,
    miningPool,
    stakePool,
    miner: referrerMiner,
    stakePosition: referrerStakePosition,
    authority: referrer.publicKey,
  })
  .signers([referrer])
  .rpc();
const referrerMinerAfterBurn = await program.account.miner.fetch(referrerMiner);
const referrerPositionAfterBurn = await program.account.stakePosition.fetch(referrerStakePosition);
assert.equal(referrerMinerAfterBurn.unclaimedMyne.toString(), '0');
assert.equal(
  BigInt(referrerPositionAfterBurn.burnPrincipal.toString())
    - BigInt(referrerPositionBeforeBurn.burnPrincipal.toString()),
  referrerBurnAmount,
  'Stake + Burn converts the complete checkpointed reward balance',
);
assert.equal(
  BigInt(referrerPositionAfterBurn.rewardWeight.toString())
    - BigInt(referrerPositionBeforeBurn.rewardWeight.toString()),
  referrerBurnAmount * 5n,
  'Stake + Burn adds exactly 5x permanent pool weight',
);
assert.equal(
  (await splToken.getMint(provider.connection, mint)).supply,
  supplyBeforeRewardBurn,
  'The fee-free virtual burn path never mints liquid MYNE',
);

const adminBalanceBeforeFallback = (await splToken.getAccount(provider.connection, adminFeeAccount)).amount;
const rogueTokens = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, rogue.publicKey);
const rogueState = await program.account.miner.fetch(rogueMiner);
const miningPoolState = await program.account.miningPool.fetch(miningPool);
const rogueEffectiveGross = miningShareValue(miningPoolState, rogueState);
const rogueAdminFee = (rogueEffectiveGross * 1_000n) / 10_000n
  - (rogueEffectiveGross * 900n) / 10_000n;
await assert.rejects(
  program.methods
    .claimMyne()
    .accounts({
      config, miningPool, miner: rogueMiner, referrerMiner: null, destinationTokens: rogueTokens.address,
      adminFeeTokens: launchAccount.address, mint, authority: rogue.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([rogue])
    .rpc(),
  /InvalidFeeDestination|token owner|constraint|custom program error/i,
);
await program.methods
  .claimMyne()
  .accounts({
    config, miningPool, miner: rogueMiner, referrerMiner: null, destinationTokens: rogueTokens.address,
    adminFeeTokens: adminFeeAccount, mint, authority: rogue.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([rogue])
  .rpc();
const adminBalanceAfterFallback = (await splToken.getAccount(provider.connection, adminFeeAccount)).amount;
assert.equal(
  adminBalanceAfterFallback - adminBalanceBeforeFallback,
  rogueAdminFee,
  'An unlabelled claim sends the 1% share to the configured admin fee wallet',
);
const mintState = await splToken.getMint(provider.connection, mint);
const launchBalance = (await splToken.getAccount(provider.connection, launchAccount.address)).amount;
const rogueBalance = (await splToken.getAccount(provider.connection, rogueTokens.address)).amount;
const adminFeeBalance = (await splToken.getAccount(provider.connection, adminFeeAccount)).amount;
const stakeVaultBalance = (await splToken.getAccount(provider.connection, stakeVault.address)).amount;
assert.equal(
  mintState.supply,
  launchBalance + rogueBalance + adminFeeBalance + stakeVaultBalance,
  'Claim mints are fully accounted for across claimant and fee destinations',
);

await program.methods
  .claimStakingRewards()
  .accounts({ stakePool, stakePosition, authority: payer.publicKey })
  .rpc();
const stakePoolState = await program.account.stakePool.fetch(stakePool);
assert.equal(stakePoolState.totalFundedLamports.toString(), '146800000');
assert.equal(stakePoolState.totalClaimedLamports.toString(), '146800000');

const archiveHash = [...createHash('sha256').update('local-round-0-canonical-snapshot').digest()];
await assert.rejects(
  program.methods
    .closeReceipt()
    .accounts({
      round, receipt: receiptFor(rogue.publicKey, new BN(20)), beneficiary: rogue.publicKey,
      executor: payer.publicKey,
    })
    .rpc(),
  /RoundNotArchived|not archived|custom program error/i,
);
await program.methods
  .archiveRound(archiveHash)
  .accounts({ config, round, randomnessAuthority: payer.publicKey })
  .rpc();
await assert.rejects(
  program.methods
    .markBuybackCompleted()
    .accounts({ config, round, buybackAuthority: rogue.publicKey })
    .signers([rogue])
    .rpc(),
  /InvalidFeeDestination|fee destination|custom program error/i,
);
await assert.rejects(
  program.methods
    .closeRound()
    .accounts({ round, rentPayer: payer.publicKey, executor: payer.publicKey })
    .rpc(),
  /RoundCleanupIncomplete|cleanup incomplete|custom program error/i,
);
const rogueBalanceBeforeRent = await provider.connection.getBalance(rogue.publicKey, 'confirmed');
for (const [authority, nonce] of [
  [payer.publicKey, new BN(10)],
  [payer.publicKey, new BN(11)],
  [payer.publicKey, new BN(0)],
  [rogue.publicKey, new BN(20)],
  [loser.publicKey, new BN(30)],
]) {
  await program.methods
    .closeReceipt()
    .accounts({
      round, receipt: receiptFor(authority, nonce), beneficiary: authority, executor: payer.publicKey,
    })
    .rpc();
  assert.equal(await program.account.betReceipt.fetchNullable(receiptFor(authority, nonce)), null);
}
const rogueBalanceAfterRent = await provider.connection.getBalance(rogue.publicKey, 'confirmed');
assert.ok(rogueBalanceAfterRent > rogueBalanceBeforeRent, 'Permissionless close returns receipt rent to its beneficiary');
roundState = await program.account.round.fetch(round);
assert.equal(roundState.closedReceipts.toString(), '5');
await program.methods
  .closeRound()
  .accounts({ round, rentPayer: payer.publicKey, executor: payer.publicKey })
  .rpc();
assert.equal(await program.account.round.fetchNullable(round), null);

await program.methods
  .proposeAdmin(rogue.publicKey)
  .accounts({ config, liquidityGate: null, liquidityPool: null, baseVault: null, quoteVault: null, admin: upgradeAuthority.publicKey })
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
    .accounts({ config, liquidityGate: null, liquidityPool: null, baseVault: null, quoteVault: null, admin: upgradeAuthority.publicKey })
    .signers(upgradeAuthoritySigners)
    .rpc(),
  /ConstraintHasOne|has one|custom program error/i,
);
await program.methods
  .setPaused(true)
  .accounts({ config, liquidityGate: null, liquidityPool: null, baseVault: null, quoteVault: null, admin: rogue.publicKey })
  .signers([rogue])
  .rpc();

state = await program.account.protocolConfig.fetch(config);
assert.equal(state.paused, true);
assert.ok(state.admin.equals(rogue.publicKey));
assert.ok(state.pendingAdmin.equals(PublicKey.default));
await assert.rejects(
  program.methods
    .migrateFeeScheduleV6()
    .accounts({
      config,
      liquidityGate: null,
      liquidityPool: null,
      admin: rogue.publicKey,
    })
    .signers([rogue])
    .rpc(),
  /ProtocolUpgradeRequired|migrated to the current fee schedule|custom program error/i,
);

// Leave a detached validator usable by the local keeper after the authorization assertions.
await program.methods
  .setPaused(false)
  .accounts({
    config,
    liquidityGate,
    liquidityPool: localPool,
    baseVault: null,
    quoteVault: null,
    admin: rogue.publicKey,
  })
  .signers([rogue])
  .rpc();
await program.methods
  .proposeAdmin(upgradeAuthority.publicKey)
  .accounts({ config, liquidityGate: null, liquidityPool: null, baseVault: null, quoteVault: null, admin: rogue.publicKey })
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
    'exact v6 fee routing, direct admin/buyback balances and audit event',
    'paused-only one-way fee migration guards',
    'permissionless accumulate and auto-burn receipt settlement',
    'archive-before-close lifecycle with receipt and round rent recovery',
    'on-chain receipt processed/closed counters and buyback closure gate',
    'standard staking plus operator and mining-funded SOL rewards',
    '10% MYNE claim fee accounting and capped minting',
    'balance-capped auto-round execution without a play-count cap',
  ],
}, null, 2));
