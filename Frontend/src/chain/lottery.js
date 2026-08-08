import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

import { assertConfiguredCluster, connection, getAccount } from './client.js';
import { GRID, MIN_ROUND_DEPLOYMENT, setGenesisTime, solanaNetwork } from './config.js';
import { formatEther, parseEther } from './units.js';
import { manualDeploymentRequiredBalance, readFeeParams } from './autocommit.js';
import { intervalReward } from './round-rewards.js';
import { roundIdsForRange } from './round-range.js';
import { loadReceiptIndex } from './rounds-index.js';
import { aggregateMiners } from './miner-aggregation.js';
import { effectiveUnclaimedMyne, miningRewardBreakdown } from './mining-shares.js';
import {
  deriveRoundProof, deriveServerEntropyProof, randomnessEqual, randomnessHex,
} from './randomness-proof.js';
import {
  commitmentHexFromAccount, describeRandomnessRound, isServerRandomnessProgram,
  SERVER_RANDOMNESS_PENDING,
} from './randomness-mode.js';
import { createReceiptNonce } from './receipt-nonce.js';
import { minerPda, minerRegistrationInstruction, stakePositionPda } from './miner-registration.js';
import {
  asBn, decodeProtocolAccount, derivePda, fetchProtocolAccount, getProtocolConfig, getWritableProgram,
  protocolPdas, protocolProgramId, sendInstructions, u64Seed,
} from './anchor-client.js';

const emptyRound = (roundId) => ({
  id: BigInt(roundId), requestedAt: 0n, resolved: false, randomnessId: null,
  randomnessMode: 'switchboard', randomnessState: 'uncommitted',
  randomnessCommitment: null, randomnessCommitSlot: null, randomnessCommitSlotEncoded: 0n,
  randomnessValue: null, winningSquare: 255, jackpotHit: false, singleMinerRound: false,
  singleMinerWinner: null, totalWager: 0n, fee: 0n, winnerTotal: 0n,
  potForWinners: 0n, bullionForWinners: 0n, payoutMulWad: 0n,
  bullionMulWad: 0n, motherlodePayoutLamports: 0n, motherlodeEmission: 0n,
  totalUnclaimedBullion: 0n, totalReceipts: 0n,
});
const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const associatedToken = (owner, mint) => PublicKey.findProgramAddressSync(
  [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID,
)[0];
const createAtaInstruction = (payer, owner, mint, ata) => new TransactionInstruction({
  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], data: new Uint8Array(),
});
const roundPda = (roundId) => derivePda('round', u64Seed(roundId));
const receiptPda = (roundId, authority, nonce) => derivePda(
  'bet', u64Seed(roundId), new PublicKey(authority), u64Seed(nonce),
);

// getProgramAccounts needs the program ID, not a config PDA. Keep the scan local and decode-only;
// production history moves to the configured indexer, while balances remain account-verifiable.
const receiptScans = new Map();
const RECEIPT_CACHE_MS = 5_000;
// 8-byte discriminator + BetReceipt::INIT_SPACE. Keep this asserted in the
// protocol capability tests whenever the receipt schema changes.
const BET_RECEIPT_ACCOUNT_SIZE = 468;
const scanReceipts = async ({ roundId = null, authority = null } = {}) => {
  const filters = [{ dataSize: BET_RECEIPT_ACCOUNT_SIZE }];
  if (roundId !== null) filters.push({ memcmp: { offset: 9, bytes: bs58.encode(u64Seed(roundId)) } });
  if (authority) filters.push({ memcmp: { offset: 17, bytes: new PublicKey(authority).toBase58() } });
  const accounts = await connection.getProgramAccounts(protocolProgramId, {
    commitment: 'confirmed',
    filters,
  });
  return accounts.flatMap((entry) => {
    try {
      const value = decodeProtocolAccount('BetReceipt', entry.account.data);
      return value ? [{ publicKey: entry.pubkey, account: value }] : [];
    } catch { return []; }
  });
};

async function decodedReceipts({
  roundId = null,
  authority = null,
  expectedReceiptCount = null,
} = {}) {
  if (!protocolProgramId) return [];
  const expected = expectedReceiptCount === null ? null : Number(toBig(expectedReceiptCount));
  const cacheKey = `${roundId ?? '*'}:${authority ?? '*'}:${expected ?? '?'}`;
  const cached = receiptScans.get(cacheKey);
  if (cached?.data && Date.now() - cached.at < RECEIPT_CACHE_MS) return cached.data;
  if (cached?.request) return cached.request;
  const request = (async () => {
    // Open receipt PDAs are the actionable wallet reward ledger. An exact
    // authority-filtered confirmed scan is bounded by that wallet's unsettled
    // receipts and cannot be made incomplete by a stalled history projector.
    // Use it before Supabase whenever a wallet is involved.
    if (authority) {
      try {
        return await scanReceipts({ roundId, authority });
      } catch {
        // Some RPC providers disable getProgramAccounts. For a specific round,
        // the completeness-gated index below is a safe fallback. An authority-
        // only index cannot prove that it did not omit an entire older round.
        if (roundId === null) {
          throw new Error('The wallet reward ledger is temporarily unavailable; no claim status was assumed');
        }
      }
    }
    // Current/previous-round participant identity has a direct confirmed fast
    // lane: this is an exact data-size + round-id memcmp, not a program-wide
    // scan. Validate its cardinality against Round.totalReceipts before use.
    if (roundId !== null && !authority && expected !== null) {
      if (expected === 0) return [];
      try {
        const decoded = await scanReceipts({ roundId });
        if (decoded.length === expected) return decoded;
      } catch {
        // Some public RPCs disable getProgramAccounts. The completeness-gated
        // durable index below remains the fallback.
      }
    }
    const indexed = await loadReceiptIndex({ roundId, address: authority });
    if (indexed) {
      const decoded = [];
      const addresses = indexed.map((row) => new PublicKey(row.receipt));
      for (let offset = 0; offset < addresses.length; offset += 100) {
        const chunk = addresses.slice(offset, offset + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
        for (let index = 0; index < chunk.length; index += 1) {
          if (!infos[index]) continue;
          const value = decodeProtocolAccount('BetReceipt', infos[index].data);
          if (value) decoded.push({ publicKey: chunk[index], account: value });
        }
      }
      if (expected !== null && decoded.length !== expected) {
        throw new Error(`Receipt projection incomplete: expected ${expected}, decoded ${decoded.length}`);
      }
      return decoded;
    }
    if (solanaNetwork.cluster === 'mainnet-beta' && roundId === null && !authority) {
      throw new Error('The production receipt index is unavailable; refusing a program-wide account scan');
    }
    const decoded = await scanReceipts({ roundId, authority });
    if (expected !== null && decoded.length !== expected) {
      throw new Error(`Receipt ledger incomplete: expected ${expected}, decoded ${decoded.length}`);
    }
    return decoded;
  })();
  receiptScans.set(cacheKey, { request, at: 0, data: null });
  try {
    const data = await request;
    receiptScans.set(cacheKey, { request: null, at: Date.now(), data });
    return data;
  } finally {
    const current = receiptScans.get(cacheKey);
    if (current?.request === request) receiptScans.set(cacheKey, { ...current, request: null });
  }
}

export const invalidateReceiptCache = () => {
  receiptScans.clear();
};

const roundFromAccount = (roundId, account) => {
  if (!account) return emptyRound(roundId);
  const winning = Number(account.winningTile);
  const winnerTotal = winning < GRID ? toBig(account.tileLamports[winning]) : 0n;
  const payoutMulWad = winnerTotal > 0n ? (toBig(account.prizeLamports) * (10n ** 18n)) / winnerTotal : 0n;
  const bullionMulWad = winnerTotal > 0n ? (toBig(account.baseEmission) * (10n ** 18n)) / winnerTotal : 0n;
  const randomnessCommitSlotEncoded = toBig(account.randomnessCommitSlot);
  const randomnessMeta = describeRandomnessRound({
    commitSlot: randomnessCommitSlotEncoded,
    resolved: account.settled,
  });
  const boundRandomness = account.randomnessAccount?.toBase58?.() ?? null;
  return {
    ...emptyRound(roundId),
    id: toBig(account.id),
    requestedAt: toBig(account.openedAt),
    resolved: account.settled,
    randomnessValue: account.randomness,
    randomnessHex: randomnessHex(account.randomness),
    // Server commitment bytes occupy the legacy Pubkey field but are not an
    // account. Keeping them out of randomnessId prevents accidental Explorer
    // links while preserving that field for historical Switchboard rounds.
    randomnessId: randomnessMeta.mode === 'server' ? null : boundRandomness,
    randomnessMode: randomnessMeta.mode,
    randomnessState: randomnessMeta.state,
    randomnessCommitment: randomnessMeta.mode === 'server'
      ? commitmentHexFromAccount(account.randomnessAccount)
      : null,
    randomnessCommitSlot: randomnessMeta.slot,
    randomnessCommitSlotEncoded,
    winningSquare: winning,
    jackpotHit: account.motherlodeHit,
    singleMinerRound: account.soloMode,
    totalWager: toBig(account.grossDeployedLamports),
    fee: (toBig(account.grossDeployedLamports) * 1200n) / 10000n,
    winnerTotal,
    potForWinners: toBig(account.prizeLamports),
    bullionForWinners: toBig(account.baseEmission),
    motherlodePayoutLamports: toBig(account.motherlodePayoutLamports),
    motherlodeEmission: toBig(account.motherlodeEmission),
    totalReceipts: toBig(account.totalReceipts),
    payoutMulWad,
    bullionMulWad,
    tileLamports: account.tileLamports.map(toBig),
    tileReceipts: account.tileReceipts.map(toBig),
    bettingEndsAt: toBig(account.bettingEndsAt),
    settlesAt: toBig(account.settlesAt),
    soloSample: toBig(account.soloSample),
  };
};

/** Decode a subscribed Round account without adding a second RPC request. */
export function decodeRoundAccountData(roundId, data) {
  return roundFromAccount(roundId, decodeProtocolAccount('Round', data));
}

export async function readRound(roundId) {
  return (await readRoundWithContext(roundId)).round;
}

/** Confirmed Round snapshot plus the RPC context slot used for monotonic UI updates. */
export async function readRoundWithContext(roundId) {
  await assertConfiguredCluster();
  const response = await connection.getAccountInfoAndContext(roundPda(roundId), 'confirmed');
  const account = response.value ? decodeProtocolAccount('Round', response.value.data) : null;
  return {
    round: roundFromAccount(roundId, account),
    slot: Number(response.context?.slot ?? 0),
  };
}

export async function syncRoundGenesis() {
  const config = await getProtocolConfig();
  setGenesisTime(toBig(config.initializedAt));
  return toBig(config.initializedAt);
}

export async function readSquareTotals(roundId) { return (await readRound(roundId)).tileLamports ?? Array(GRID).fill(0n); }
export async function readSquareMiners(roundId) { return (await readRound(roundId)).tileReceipts ?? Array(GRID).fill(0n); }
export async function readJackpot() {
  const config = await getProtocolConfig();
  return { native: toBig(config.motherlodeLamports), bullion: toBig(config.motherlodeBaseUnits) };
}

async function tokenBalance(owner, mint) {
  const rows = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
  return rows.value.reduce((sum, row) => sum + BigInt(row.account.data.parsed.info.tokenAmount.amount), 0n);
}

export async function readMiner(address) {
  const authority = new PublicKey(address);
  const accountAddresses = [
    minerPda(address),
    protocolPdas.miningPool,
    stakePositionPda(address),
    protocolPdas.stakePool,
  ];
  const [config, accountSnapshot, balance] = await Promise.all([
    getProtocolConfig(),
    connection.getMultipleAccountsInfoAndContext(accountAddresses, 'confirmed'),
    connection.getBalance(authority, 'confirmed'),
  ]);
  const decodeSnapshotAccount = (name, info) => {
    if (!info) return null;
    if (!info.owner.equals(protocolProgramId)) throw new Error(`${name} account has the wrong owner`);
    return decodeProtocolAccount(name, info.data);
  };
  const [miner, miningPool, stakePosition, stakePool] = [
    decodeSnapshotAccount('Miner', accountSnapshot.value[0]),
    decodeSnapshotAccount('MiningPool', accountSnapshot.value[1]),
    decodeSnapshotAccount('StakePosition', accountSnapshot.value[2]),
    decodeSnapshotAccount('StakePool', accountSnapshot.value[3]),
  ];
  const rewardBreakdown = miningRewardBreakdown(miner, miningPool);
  const rewardIndex = toBig(stakePool?.rewardPerWeight);
  const rewardDebt = toBig(stakePosition?.rewardDebt);
  const rewardWeight = toBig(stakePosition?.rewardWeight);
  if (rewardIndex < rewardDebt) throw new Error('Stake reward index is behind the position checkpoint');
  // `pendingSol` is the durable claim ledger for both staking distributions
  // and processed mining receipts. Include the not-yet-checkpointed staking
  // index delta so every Claim SOL surface reads the exact live liability.
  const claimableSol = toBig(stakePosition?.pendingSol)
    + (rewardWeight * (rewardIndex - rewardDebt)) / 1_000_000_000_000_000_000n;
  return {
    account: address,
    balance: BigInt(balance),
    bullionBalance: await tokenBalance(address, config.mint),
    rewardsBullion: rewardBreakdown.total,
    claimableSol,
    refinedAccrued: rewardBreakdown.passive,
    hasAccount: Boolean(miner),
    hasPosition: Boolean(stakePosition),
    totalUnclaimed: toBig(miningPool?.totalUnclaimed),
    hasReferrer: Boolean(miner && !miner.referrer.equals(PublicKey.default)),
    minerIndex: toBig(miningPool?.rewardPerUnclaimed),
  };
}

// V6 credits a round only when its receipt is settled and never back-dates new
// shares into passive fees paid before that settlement. `readMiner` already
// values all existing shares at the current pool asset value.
export function passiveOnRounds() { return 0n; }
export function netClaimable({ grossMined, refinedAccrued = 0n }) {
  const total = grossMined + refinedAccrued;
  return total - (total * 1000n) / 10000n;
}

export async function readMyBets(roundId, address) {
  const totals = Array(GRID).fill(0n);
  for (const { account } of await decodedReceipts({ roundId, authority: address })) {
    if (toBig(account.roundId) !== BigInt(roundId) || !account.authority.equals(new PublicKey(address))) continue;
    account.amounts.forEach((amount, index) => { totals[index] += toBig(amount); });
  }
  return totals;
}

/**
 * Authoritative candidate rounds for this wallet's actionable receipt ledger.
 * Open BetReceipt PDAs are bounded per wallet and survive until their reward or
 * refund has been processed, so a stalled history projection cannot hide one.
 */
export async function readWalletReceiptRounds(address) {
  if (!address) return [];
  const receipts = await decodedReceipts({ authority: address });
  const ids = [...new Set(receipts
    .filter(({ account }) => !account.claimed && !account.refunded)
    .map(({ account }) => toBig(account.roundId).toString()))]
    .map(BigInt);
  const rounds = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(batch.map(roundPda), 'confirmed');
    infos.forEach((info, index) => {
      if (!info) return;
      const roundId = batch[index];
      rounds.push({
        roundId,
        ...roundFromAccount(roundId, decodeProtocolAccount('Round', info.data)),
      });
    });
  }
  return rounds;
}

export async function placeBet({ roundId, tiles, ethPerTile }) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const authority = new PublicKey(account);
  const perTile = parseEther(String(ethPerTile));
  const amounts = Array(GRID).fill(0n);
  for (const tile of tiles) amounts[Number(tile) - 1] = perTile;
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (total < MIN_ROUND_DEPLOYMENT) throw new Error('Minimum total deployment is 0.05 SOL per round');
  const nonce = createReceiptNonce();
  const round = roundPda(roundId);
  const miner = minerPda(account);
  const receipt = receiptPda(roundId, account, nonce);
  const { program } = await getWritableProgram();
  const configState = await getProtocolConfig();
  if (configState.paused) {
    throw new Error('Mining is temporarily paused while maintenance is completed. No bids can be placed right now.');
  }
  const configuredRandomnessProgram = new PublicKey(configState.randomnessProgram);
  const providerRandomness = !configuredRandomnessProgram.equals(PublicKey.default);
  const configuredServerMode = isServerRandomnessProgram(configuredRandomnessProgram);
  const roundState = await fetchProtocolAccount('Round', round);
  const instructions = [];
  const registration = await minerRegistrationInstruction({ program, authority });
  const feeParams = await readFeeParams();
  const walletBalance = await connection.getBalance(authority, 'confirmed');
  const requiredBalance = manualDeploymentRequiredBalance({
    amount: total,
    hasMiner: !registration.instruction,
    feeParams,
  });
  if (BigInt(walletBalance) < requiredBalance) {
    const shortfall = requiredBalance - BigInt(walletBalance);
    throw new Error(
      `Not enough SOL for this deployment. Need ${formatEther(requiredBalance)} SOL total `
      + `(deployment, account rent and network fee); add ${formatEther(shortfall)} SOL or lower the amount.`,
    );
  }
  if (registration.instruction) instructions.push(registration.instruction);
  if (!roundState) {
    if (providerRandomness) {
      throw new Error('This round is being prepared by the verified-randomness keeper. Please try again shortly.');
    }
    instructions.push(await program.methods.openRound(asBn(roundId)).accounts({
      config: protocolPdas.config, round, payer: authority, systemProgram: SystemProgram.programId,
    }).instruction());
  }
  let randomnessAccount = null;
  if (roundState) {
    const encodedSlot = toBig(roundState.randomnessCommitSlot);
    const randomnessMeta = describeRandomnessRound({ commitSlot: encodedSlot, resolved: roundState.settled });
    const boundRandomness = roundState.randomnessAccount;
    const hasBoundRandomness = boundRandomness && !new PublicKey(boundRandomness).equals(PublicKey.default);
    if (randomnessMeta.mode === 'server') {
      if (!hasBoundRandomness) {
        throw new Error('This round is waiting for its server randomness commitment. Please try again shortly.');
      }
      if (encodedSlot !== SERVER_RANDOMNESS_PENDING) {
        throw new Error('Betting has closed and the server entropy slot is already locked.');
      }
      // The commitment is stored as bytes in Round; it is deliberately not an
      // account and the optional deploy account must be omitted.
      randomnessAccount = null;
    } else if (hasBoundRandomness) {
      if (encodedSlot > 0n) throw new Error('Betting has closed and this round randomness is already committed.');
      // A previously opened Switchboard round stays executable even if the
      // provider configured for future rounds has changed.
      randomnessAccount = boundRandomness;
    } else if (providerRandomness) {
      const provider = configuredServerMode ? 'server commitment' : 'uncommitted Switchboard request';
      throw new Error(`This round is waiting for its ${provider}. Please try again shortly.`);
    }
  }
  instructions.push(await program.methods.deploy(asBn(roundId), asBn(nonce), amounts.map(asBn)).accounts({
    config: protocolPdas.config, miner, round, receipt, randomnessAccount, authority,
    systemProgram: SystemProgram.programId,
  }).instruction());
  const signature = await sendInstructions(instructions);
  invalidateReceiptCache();
  return signature;
}

async function claimableReceipts(roundIds, authority) {
  const wanted = new Set(roundIds.map((id) => BigInt(id).toString()));
  const authorityKey = new PublicKey(authority);
  // One confirmed authority-filtered scan is the wallet's complete actionable
  // ledger. Reuse it for every selected round instead of bursting one
  // getProgramAccounts request per round from Claim All.
  const rows = await decodedReceipts({ authority });
  return rows.filter(({ account }) => wanted.has(toBig(account.roundId).toString())
    && account.authority.equals(authorityKey)
    && !account.claimed && !account.refunded);
}

export const NO_UNCLAIMED_RECEIPTS = 'NO_UNCLAIMED_RECEIPTS';
const noUnclaimedReceipts = (message) => Object.assign(new Error(message), {
  code: NO_UNCLAIMED_RECEIPTS,
});

const claimRoundKey = (value) => toBig(value?.account?.roundId ?? value?.roundId).toString();
const uniqueClaimRoundIds = (roundIds) => [
  ...new Map(roundIds.map((roundId) => [toBig(roundId).toString(), roundId])).values(),
];

/**
 * Submit atomic receipt chunks and reconcile partial progress against the
 * confirmed wallet receipt ledger before reporting it to the UI.
 *
 * `sendInstructions` confirms each successful chunk before it returns. If a
 * later chunk fails, those earlier chunks cannot be rolled back. A keeper may
 * also process any remaining receipt concurrently, so transaction counts alone
 * cannot say which rounds remain. The confirmed rescan is the authority.
 */
export async function executeClaimChunks({
  requestedRoundIds,
  claims,
  sendChunk,
  reconcileRemaining,
  chunkSize = 4,
}) {
  const requested = uniqueClaimRoundIds(requestedRoundIds);
  const initialClaimsByRound = new Map();
  const confirmedClaimsByRound = new Map();
  for (const claim of claims) {
    const key = claimRoundKey(claim);
    initialClaimsByRound.set(key, (initialClaimsByRound.get(key) ?? 0) + 1);
  }

  let signature = null;
  let confirmedReceiptCount = 0;
  for (let offset = 0; offset < claims.length; offset += chunkSize) {
    const chunk = claims.slice(offset, offset + chunkSize);
    try {
      signature = await sendChunk(chunk);
      confirmedReceiptCount += chunk.length;
      for (const claim of chunk) {
        const key = claimRoundKey(claim);
        confirmedClaimsByRound.set(key, (confirmedClaimsByRound.get(key) ?? 0) + 1);
      }
    } catch (failure) {
      try {
        const remainingClaims = await reconcileRemaining();
        const remainingKeys = new Set(remainingClaims.map(claimRoundKey));
        const processedRoundIds = requested.filter((roundId) => !remainingKeys.has(claimRoundKey({ roundId })));
        const remainingRoundIds = requested.filter((roundId) => remainingKeys.has(claimRoundKey({ roundId })));
        return {
          status: remainingRoundIds.length === 0
            ? 'complete'
            : (processedRoundIds.length > 0 ? 'partial' : 'failed'),
          signature,
          processedRoundIds,
          remainingRoundIds,
          confirmedReceiptCount,
          failure,
          reconciled: true,
        };
      } catch (reconciliationError) {
        // Even when the rescan itself is unavailable, preserve the minimum
        // progress proven by confirmed atomic chunks. Do not guess that any
        // unverified round is complete.
        const processedRoundIds = requested.filter((roundId) => {
          const key = claimRoundKey({ roundId });
          return (confirmedClaimsByRound.get(key) ?? 0) >= (initialClaimsByRound.get(key) ?? 0);
        });
        const processedKeys = new Set(processedRoundIds.map((roundId) => claimRoundKey({ roundId })));
        return {
          status: 'unverified',
          signature,
          processedRoundIds,
          remainingRoundIds: requested.filter((roundId) => !processedKeys.has(claimRoundKey({ roundId }))),
          confirmedReceiptCount,
          failure,
          reconciliationError,
          reconciled: false,
        };
      }
    }
  }

  return {
    status: 'complete',
    signature,
    processedRoundIds: requested,
    remainingRoundIds: [],
    confirmedReceiptCount,
    failure: null,
    reconciled: true,
  };
}

export async function claimRound(roundId) {
  const account = getAccount();
  const rows = await claimableReceipts([roundId], account);
  if (!rows.length) throw noUnclaimedReceipts('No unclaimed receipt for this round');
  const authority = new PublicKey(account);
  const { program } = await getWritableProgram();
  const ixs = await Promise.all(rows.map(({ publicKey, account: receipt }) => program.methods.claimReceipt().accounts({
    config: protocolPdas.config, miningPool: protocolPdas.miningPool, stakePool: protocolPdas.stakePool,
    miner: minerPda(account), stakePosition: stakePositionPda(account), round: roundPda(receipt.roundId),
    receipt: publicKey, authority,
  }).instruction()));
  const signature = await sendInstructions(ixs);
  invalidateReceiptCache();
  return signature;
}
export async function claimManyRounds(roundIds) {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const rows = await claimableReceipts(roundIds, account);
  if (!rows.length) throw noUnclaimedReceipts('No unclaimed receipts for these rounds');
  const authority = new PublicKey(account);
  const { program } = await getWritableProgram();
  const claims = await Promise.all(rows.map(async ({ publicKey, account: receipt }) => ({
    roundId: toBig(receipt.roundId),
    instruction: await program.methods.claimReceipt().accounts({
      config: protocolPdas.config, miningPool: protocolPdas.miningPool,
      stakePool: protocolPdas.stakePool, miner: minerPda(account),
      stakePosition: stakePositionPda(account), round: roundPda(receipt.roundId),
      receipt: publicKey, authority,
    }).instruction(),
  })));
  // Four receipt settlements remain below legacy transaction account/compute
  // limits in the measured client path. Each chunk is simulated by
  // sendInstructions before the wallet is asked to sign.
  try {
    return await executeClaimChunks({
      requestedRoundIds: roundIds,
      claims,
      sendChunk: async (chunk) => {
        const signature = await sendInstructions(chunk.map(({ instruction }) => instruction));
        // Each confirmed chunk is durable. Remove its receipts from every
        // subsequent read immediately, even if a later wallet prompt is rejected.
        invalidateReceiptCache();
        return signature;
      },
      reconcileRemaining: async () => {
        invalidateReceiptCache();
        return claimableReceipts(roundIds, account);
      },
    });
  } finally {
    // Also clear in-flight/cache state on a failed simulation or wallet prompt;
    // an independent lifecycle worker may have processed the same receipts.
    invalidateReceiptCache();
  }
}
export const claimManyEthOnly = claimManyRounds;

export async function withdrawUnrefined() {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const authority = new PublicKey(account);
  const [config, miner, miningPool] = await Promise.all([
    getProtocolConfig(),
    fetchProtocolAccount('Miner', minerPda(account)),
    fetchProtocolAccount('MiningPool', protocolPdas.miningPool),
  ]);
  if (effectiveUnclaimedMyne(miner, miningPool) === 0n) throw new Error('Nothing to claim');
  const mint = new PublicKey(config.mint);
  const destinationTokens = associatedToken(authority, mint);
  const adminFeeWallet = new PublicKey(config.adminFeeWallet);
  const hasReferrer = !miner.referrer.equals(PublicKey.default);
  const adminFeeTokens = hasReferrer ? null : associatedToken(adminFeeWallet, mint);
  const { program } = await getWritableProgram();
  const instructions = [];
  if (!(await connection.getAccountInfo(destinationTokens, 'confirmed'))) instructions.push(createAtaInstruction(authority, authority, mint, destinationTokens));
  if (adminFeeTokens && !(await connection.getAccountInfo(adminFeeTokens, 'confirmed'))) {
    instructions.push(createAtaInstruction(authority, adminFeeWallet, mint, adminFeeTokens));
  }
  const referrerMiner = miner.referrer.equals(PublicKey.default) ? null : minerPda(miner.referrer);
  instructions.push(await program.methods.claimMyne().accounts({
    config: protocolPdas.config, miningPool: protocolPdas.miningPool, miner: minerPda(account),
    referrerMiner, destinationTokens, adminFeeTokens, mint, authority, tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction());
  return sendInstructions(instructions);
}

/**
 * Permanently convert all accumulated, unminted MYNE into 5x staking weight.
 *
 * This is intentionally a dedicated program instruction. Minting through `claimMyne` first would
 * apply the liquid-claim fee and require a second token burn, contradicting the UI's 0% fee path.
 */
export async function burnUnclaimedMyne() {
  const account = getAccount();
  if (!account) throw new Error('Connect a Solana wallet first');
  const [miner, miningPool, stakePosition] = await Promise.all([
    fetchProtocolAccount('Miner', minerPda(account)),
    fetchProtocolAccount('MiningPool', protocolPdas.miningPool),
    fetchProtocolAccount('StakePosition', stakePositionPda(account)),
  ]);
  if (effectiveUnclaimedMyne(miner, miningPool) === 0n) throw new Error('Nothing to stake and burn');
  if (!stakePosition) throw new Error('This wallet has no staking reward account');
  const authority = new PublicKey(account);
  const { program } = await getWritableProgram();
  const instruction = await program.methods.burnUnclaimedMyne().accounts({
    config: protocolPdas.config,
    miningPool: protocolPdas.miningPool,
    stakePool: protocolPdas.stakePool,
    miner: minerPda(account),
    stakePosition: stakePositionPda(account),
    authority,
  }).instruction();
  return sendInstructions([instruction]);
}

export async function readRoundWinners(roundId) {
  const round = await readRound(roundId);
  const receiptRows = await decodedReceipts({
    roundId,
    expectedReceiptCount: round.totalReceipts,
  });
  const miners = aggregateMiners(receiptRows);
  if (!round.resolved || round.winningSquare >= GRID) {
    return { winningSquare: round.winningSquare, winnerTotal: round.winnerTotal, solo: false, winners: [], miners };
  }
  const winningSquare = Number(round.winningSquare);
  const soloSample = toBig(round.soloSample);
  let soloWinner = null;
  if (round.singleMinerRound) {
    const receipt = receiptRows.find(({ account }) => {
      const amount = toBig(account.amounts[winningSquare]);
      const start = toBig(account.cumulativeStarts[winningSquare]);
      return amount > 0n && soloSample >= start && soloSample < start + amount;
    });
    soloWinner = receipt?.account.authority.toBase58() ?? null;
  }
  const enriched = miners.map((miner) => {
    const minerReceipts = receiptRows.filter(({ account }) => account.authority.toBase58() === miner.address);
    const winningStake = miner.tileBets[winningSquare] ?? 0n;
    const onWinningTile = winningStake > 0n && round.winnerTotal > 0n;
    const isSoloWinner = round.singleMinerRound && soloWinner === miner.address;
    const solReward = minerReceipts.reduce((sum, { account }) => sum + intervalReward(
      round.potForWinners,
      account.cumulativeStarts[winningSquare],
      account.amounts[winningSquare],
      round.winnerTotal,
    ), 0n);
    const motherlodeSolReward = minerReceipts.reduce((sum, { account }) => sum + intervalReward(
      round.motherlodePayoutLamports,
      account.cumulativeStarts.reduce((total, value) => total + toBig(value), 0n),
      account.totalLamports,
      round.totalWager,
    ), 0n);
    const baseBullionReward = !onWinningTile ? 0n
      : round.singleMinerRound ? (isSoloWinner ? round.bullionForWinners : 0n)
        : minerReceipts.reduce((sum, { account }) => sum + intervalReward(
          round.bullionForWinners,
          account.cumulativeStarts[winningSquare],
          account.amounts[winningSquare],
          round.winnerTotal,
        ), 0n);
    const motherlodeBullionReward = round.jackpotHit && round.totalWager > 0n
      ? minerReceipts.reduce((sum, { account }) => sum + intervalReward(
        round.motherlodeEmission,
        account.cumulativeStarts.reduce((total, value) => total + toBig(value), 0n),
        account.totalLamports,
        round.totalWager,
      ), 0n)
      : 0n;
    const bullionReward = baseBullionReward + motherlodeBullionReward;
    return {
      ...miner,
      wagered: miner.deployed,
      eth: solReward + motherlodeSolReward,
      // Keep the winning-tile leg separate so the miner popup can explain why total
      // deployment and SOL reward are different values. `eth` includes any Motherlode share.
      winningStake,
      winningTileTotal: round.winnerTotal,
      winningSolReward: solReward,
      motherlodeSolReward,
      prizeLamports: round.potForWinners,
      bullion: bullionReward,
      won: onWinningTile || (round.jackpotHit && miner.deployed > 0n),
      onWinningTile,
      isSoloWinner,
      motherlodeShare: motherlodeSolReward > 0n || motherlodeBullionReward > 0n,
      amountKnown: true,
    };
  });
  return {
    winningSquare,
    winnerTotal: round.winnerTotal,
    solo: round.singleMinerRound,
    winners: enriched.filter((miner) => miner.won),
    miners: enriched,
  };
}

export async function readRoundMiners(roundId) {
  const round = await readRound(roundId);
  const rows = await decodedReceipts({ roundId, expectedReceiptCount: round.totalReceipts });
  return aggregateMiners(rows);
}
export async function readRecentRounds(latestRoundId, lookback = 80) { return readRoundsRange(BigInt(latestRoundId) - BigInt(lookback), latestRoundId); }

export async function readRoundsRange(fromId, toId, maxScan = 2000) {
  const { ids, truncated } = roundIdsForRange(fromId, toId, maxScan);
  const rounds = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batchIds = ids.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(batchIds.map(roundPda), 'confirmed');
    infos.forEach((info, index) => {
      if (!info) return;
      const id = batchIds[index];
      const account = decodeProtocolAccount('Round', info.data);
      const round = { roundId: id, ...roundFromAccount(id, account) };
      if (round.requestedAt > 0n) rounds.push(round);
    });
  }
  return { rounds, truncated };
}
export async function readExpectedRewards(rounds, address) {
  const receipts = address ? await decodedReceipts({ authority: address }) : [];
  const authority = address ? new PublicKey(address) : null;
  const expected = new Map();
  for (const round of rounds) {
    const key = String(round.roundId);
    if (!authority) {
      expected.set(key, 0n);
      continue;
    }
    const mine = receipts.filter(({ account }) => toBig(account.roundId) === BigInt(round.roundId)
      && account.authority.equals(authority) && !account.claimed && !account.refunded);
    expected.set(key, expectedReceiptMyneReward(round, mine.map(({ account }) => account)));
  }
  return expected;
}

/** Pure exact unprocessed-receipt MYNE accrual, mirroring `receipt_rewards`. */
export function expectedReceiptMyneReward(round, receiptAccounts) {
  const winningSquare = Number(round.winningSquare);
  let reward = 0n;
  if (winningSquare >= 0 && winningSquare < GRID && toBig(round.winnerTotal) > 0n) {
    if (round.singleMinerRound) {
      const soloSample = round.soloSample === undefined || round.soloSample === null
        ? null
        : toBig(round.soloSample);
      const selected = receiptAccounts.some((account) => {
        const amount = toBig(account.amounts[winningSquare]);
        const start = toBig(account.cumulativeStarts[winningSquare]);
        return soloSample !== null && amount > 0n
          && soloSample >= start && soloSample < start + amount;
      });
      if (selected) reward += toBig(round.bullionForWinners);
    } else {
      reward += receiptAccounts.reduce((sum, account) => sum + intervalReward(
        toBig(round.bullionForWinners),
        account.cumulativeStarts[winningSquare],
        account.amounts[winningSquare],
        toBig(round.winnerTotal),
      ), 0n);
    }
  }
  if (round.jackpotHit && toBig(round.totalWager) > 0n) {
    reward += receiptAccounts.reduce((sum, account) => sum + intervalReward(
      toBig(round.motherlodeEmission),
      account.cumulativeStarts.reduce((total, value) => total + toBig(value), 0n),
      account.totalLamports,
      toBig(round.totalWager),
    ), 0n);
  }
  return reward;
}

/** Pure exact receipt accrual: normal winning tile plus round-wide Motherlode. */
export function expectedReceiptSolReward(round, receiptAccounts) {
  const winningSquare = Number(round.winningSquare);
  let reward = 0n;
  if (winningSquare >= 0 && winningSquare < GRID && toBig(round.winnerTotal) > 0n) {
    reward += receiptAccounts.reduce((sum, account) => sum + intervalReward(
      toBig(round.potForWinners),
      account.cumulativeStarts[winningSquare],
      account.amounts[winningSquare],
      toBig(round.winnerTotal),
    ), 0n);
  }
  if (round.jackpotHit && toBig(round.totalWager) > 0n) {
    reward += receiptAccounts.reduce((sum, account) => sum + intervalReward(
      toBig(round.motherlodePayoutLamports),
      account.cumulativeStarts.reduce((total, value) => total + toBig(value), 0n),
      account.totalLamports,
      toBig(round.totalWager),
    ), 0n);
  }
  return reward;
}

/** Exact per-wallet SOL accrual for every open reward receipt. */
export async function readExpectedSolRewards(rounds, address) {
  const receipts = address ? await decodedReceipts({ authority: address }) : [];
  const authority = address ? new PublicKey(address) : null;
  const expected = new Map();
  for (const round of rounds) {
    const key = String(round.roundId);
    if (!authority) {
      expected.set(key, 0n);
      continue;
    }
    const mine = receipts.filter(({ account }) => toBig(account.roundId) === BigInt(round.roundId)
      && account.authority.equals(authority) && !account.claimed && !account.refunded);
    expected.set(key, expectedReceiptSolReward(round, mine.map(({ account }) => account)));
  }
  return expected;
}
export async function readRoundIndexAtResolve(rounds) {
  return new Map(rounds.map((round) => [String(round.roundId), 0n]));
}
export async function readSettlementTx() { return null; }
export async function readWinnerCounts(rounds) {
  const counts = new Map();
  for (const round of rounds) {
    const receipts = await decodedReceipts({
      roundId: round.roundId,
      expectedReceiptCount: round.totalReceipts,
    });
    const winners = new Set();
    const square = Number(round.winningSquare);
    let soloWinner = null;
    const soloSample = round.soloSample === undefined || round.soloSample === null
      ? null
      : toBig(round.soloSample);
    if (round.jackpotHit) {
      for (const { account } of receipts) {
        if (toBig(account.roundId) === BigInt(round.roundId) && !account.refunded && toBig(account.totalLamports) > 0n) {
          winners.add(account.authority.toBase58());
        }
      }
      counts.set(String(round.roundId), BigInt(winners.size));
      continue;
    }
    if (round.resolved && square >= 0 && square < GRID) {
      for (const { account } of receipts) {
        if (toBig(account.roundId) !== BigInt(round.roundId) || account.refunded) continue;
        const amount = toBig(account.amounts[square]);
        if (amount <= 0n) continue;
        const address = account.authority.toBase58();
        winners.add(address);
        const start = toBig(account.cumulativeStarts[square]);
        if (round.singleMinerRound && soloSample !== null && soloSample >= start && soloSample < start + amount) {
          soloWinner = address;
        }
      }
    }
    // The row renderer needs both the raw eligible-miner count (for "1 of N") and the selected
    // Solo authority. Round stores the deterministic sample, while receipts map it to a wallet.
    if (soloWinner) round.singleMinerWinner = soloWinner;
    counts.set(String(round.roundId), BigInt(winners.size));
  }
  return counts;
}
export async function readMyClaimStatus(rounds, address) {
  const statuses = new Map();
  if (!address) {
    rounds.forEach((round) => statuses.set(String(round.roundId), { myBet: 0n, claimed: false }));
    return statuses;
  }
  const receipts = await decodedReceipts({ authority: address });
  const authority = new PublicKey(address);
  for (const round of rounds) {
    const square = Number(round.winningSquare);
    const mine = receipts.filter(({ account }) => toBig(account.roundId) === BigInt(round.roundId)
      && account.authority.equals(authority) && !account.refunded);
    const winning = round.jackpotHit
      ? mine.filter(({ account }) => toBig(account.totalLamports) > 0n)
      : square >= 0 && square < GRID
        ? mine.filter(({ account }) => toBig(account.amounts[square]) > 0n)
        : [];
    statuses.set(String(round.roundId), {
      myBet: winning.reduce((sum, { account }) => sum + toBig(round.jackpotHit ? account.totalLamports : account.amounts[square]), 0n),
      claimed: winning.length > 0 && winning.every(({ account }) => Boolean(account.claimed)),
    });
  }
  return statuses;
}
export const countUnknownClaimStatus = () => 0;
export async function verifyRoundTiming(roundDuration, bettingDuration) {
  const config = await getProtocolConfig();
  if (toBig(config.roundDurationSeconds) !== BigInt(roundDuration) || toBig(config.bettingDurationSeconds) !== BigInt(bettingDuration)) throw new Error('Frontend round timing differs from the deployed protocol');
  return true;
}
export async function verifyFeeEconomics(expected) { return Number(expected.protocolFeeBps) === 1200; }
export async function verifyPremine() { return true; }
export async function waitForTx(signature) {
  const result = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  return { status: result.value?.err ? 'reverted' : 'success' };
}
export async function readDrandTargetRound() { return null; }
export async function verifyRoundFairness(roundId, randomnessValue, winningSquare, providerProof = null) {
  const round = await readRound(roundId);
  if (!round.resolved) return { ok: false, reason: 'Round is not settled' };
  const proof = await deriveRoundProof(roundId, round.randomnessValue);
  const randomnessMatches = randomnessEqual(round.randomnessValue, randomnessValue);
  const squareMatches = proof.winningSquare === Number(winningSquare)
    && proof.winningSquare === round.winningSquare;
  const modeMatches = proof.soloMode === round.singleMinerRound;
  const motherlodeMatches = proof.motherlodeHit === round.jackpotHit;
  const outcomeMatches = randomnessMatches && squareMatches && modeMatches && motherlodeMatches;
  let serverProof = null;
  if (round.randomnessMode === 'server') {
    const commitment = providerProof?.commitmentHex ?? round.randomnessCommitment;
    const reveal = providerProof?.revealHex ?? null;
    const entropySlot = providerProof?.entropySlot ?? round.randomnessCommitSlot;
    const slotHash = providerProof?.slotHashHex ?? null;
    if (commitment && reveal && entropySlot !== null && slotHash) {
      const config = await getProtocolConfig();
      serverProof = await deriveServerEntropyProof({
        programId: protocolProgramId,
        mint: config.mint,
        roundId,
        reveal,
        entropySlot,
        slotHash,
        commitment,
        randomness: round.randomnessValue,
      });
    }
  }
  const serverProofComplete = round.randomnessMode !== 'server'
    || Boolean(serverProof);
  const serverProofMatches = round.randomnessMode !== 'server'
    || Boolean(serverProof?.commitmentMatches && serverProof?.randomnessMatches);
  return {
    ...proof,
    ok: outcomeMatches && serverProofComplete && serverProofMatches,
    outcomeMatches,
    randomnessMatches,
    squareMatches,
    modeMatches,
    motherlodeMatches,
    randomnessMode: round.randomnessMode,
    randomnessState: round.randomnessState,
    randomnessAccount: round.randomnessId,
    randomnessCommitment: round.randomnessCommitment,
    randomnessCommitSlot: round.randomnessCommitSlot,
    serverCommitmentMatches: serverProof?.commitmentMatches ?? null,
    serverOutputMatches: serverProof?.randomnessMatches ?? null,
    serverProofComplete,
  };
}
