import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';

const { AnchorProvider, Program, setProvider } = anchor;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
const program = new Program(idl, provider);
const connection = provider.connection;

const u64Seed = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};
const pda = (seed, ...extra) => PublicKey.findProgramAddressSync(
  [Buffer.from(seed), ...extra.map((value) => Buffer.from(value))],
  PROGRAM_ID,
)[0];
const configAddress = pda('config');
const config = await program.account.protocolConfig.fetch(configAddress);
const genesisHash = await connection.getGenesisHash();
assert.equal(genesisHash, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');

const clock = await connection.getBlockTime(await connection.getSlot('finalized'));
assert.ok(Number.isSafeInteger(clock));
const initializedAt = Number(config.initializedAt.toString());
const currentRound = Math.max(0, Math.floor((clock - initializedAt) / 65));
const addresses = Array.from({ length: currentRound + 2 }, (_, id) => pda('round', u64Seed(id)));
const infos = [];
for (let offset = 0; offset < addresses.length; offset += 100) {
  infos.push(...await connection.getMultipleAccountsInfo(addresses.slice(offset, offset + 100), 'finalized'));
}

const rounds = [];
for (let id = 0; id < infos.length; id += 1) {
  const info = infos[id];
  if (!info) continue;
  assert.equal(info.owner.toBase58(), PROGRAM_ID.toBase58());
  const state = program.coder.accounts.decode('round', info.data);
  const rent = await connection.getMinimumBalanceForRentExemption(info.data.length);
  rounds.push({
    id,
    address: addresses[id].toBase58(),
    lamports: info.lamports,
    rent,
    excess: info.lamports - rent,
    settled: Boolean(state.settled),
    totalReceipts: Number(state.totalReceipts.toString()),
    processedReceipts: Number(state.processedReceipts.toString()),
    closedReceipts: Number(state.closedReceipts.toString()),
    claimedLamports: state.claimedLamports.toString(),
    prizeLamports: state.prizeLamports.toString(),
    motherlodePayoutLamports: state.motherlodePayoutLamports.toString(),
    buybackCompleted: Boolean(state.buybackCompleted),
    archivedAtSlot: state.archivedAtSlot.toString(),
    refundAt: Number(state.refundAt.toString()),
    rentPayer: state.rentPayer.toBase58(),
    randomnessAccount: state.randomnessAccount.toBase58(),
  });
}

const indexBase = String(process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const indexKey = process.env.VITE_SUPABASE_ANON_KEY || '';
assert.match(indexBase, /^https:\/\//);
assert.ok(indexKey);
async function indexRead(path) {
  const response = await fetch(`${indexBase}/rest/v1/${path}`, {
    headers: { apikey: indexKey, Authorization: `Bearer ${indexKey}` },
  });
  const text = await response.text();
  assert.ok(response.ok, `${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}
async function indexReadAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await indexRead(`${path}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
const indexedBetRows = await indexReadAll('mine_round_bets?select=round_id,receipt,bettor&order=round_id.asc');
const uniqueReceipts = [...new Map(indexedBetRows.map((row) => [row.receipt, row])).values()];
const receiptAddresses = uniqueReceipts.map((row) => new PublicKey(row.receipt));
const receiptInfos = [];
for (let offset = 0; offset < receiptAddresses.length; offset += 100) {
  receiptInfos.push(...await connection.getMultipleAccountsInfo(receiptAddresses.slice(offset, offset + 100), 'finalized'));
}
const receipts = [];
for (let index = 0; index < receiptInfos.length; index += 1) {
  const info = receiptInfos[index];
  if (!info) continue;
  assert.equal(info.owner.toBase58(), PROGRAM_ID.toBase58());
  const state = program.coder.accounts.decode('betReceipt', info.data);
  const rent = await connection.getMinimumBalanceForRentExemption(info.data.length);
  receipts.push({
    roundId: Number(state.roundId.toString()),
    address: receiptAddresses[index].toBase58(),
    authority: state.authority.toBase58(),
    lamports: info.lamports,
    rent,
    claimed: Boolean(state.claimed),
    refunded: Boolean(state.refunded),
  });
}

const beneficiaries = [...new Set(uniqueReceipts.map((row) => row.bettor))].map((value) => new PublicKey(value));
const stakeAddresses = beneficiaries.map((authority) => pda('stake_position', authority.toBuffer()));
const stakeStates = await program.account.stakePosition.fetchMultiple(stakeAddresses);
const stakes = beneficiaries.flatMap((authority, index) => stakeStates[index] ? [{
  authority: authority.toBase58(),
  pendingSol: stakeStates[index].pendingSol.toString(),
}] : []);

const randomnessAddresses = [...new Set(rounds.map((round) => round.randomnessAccount))]
  .filter((address) => address !== PublicKey.default.toBase58())
  .map((address) => new PublicKey(address));
const randomnessInfos = [];
for (let offset = 0; offset < randomnessAddresses.length; offset += 100) {
  randomnessInfos.push(...await connection.getMultipleAccountsInfo(randomnessAddresses.slice(offset, offset + 100), 'finalized'));
}
const randomness = randomnessInfos.flatMap((info, index) => info ? [{
  address: randomnessAddresses[index].toBase58(),
  lamports: info.lamports,
  bytes: info.data.length,
  owner: info.owner.toBase58(),
}] : []);

const sum = (rows, field) => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
const unprocessed = receipts.filter((receipt) => !receipt.claimed && !receipt.refunded);
const processedOpen = receipts.filter((receipt) => receipt.claimed || receipt.refunded);
const archiveEligible = rounds.filter((round) => round.archivedAtSlot === '0'
  && round.processedReceipts === round.totalReceipts
  && (round.settled ? round.buybackCompleted : clock >= round.refundAt));
const closeEligible = rounds.filter((round) => round.archivedAtSlot !== '0'
  && round.processedReceipts === round.totalReceipts
  && round.closedReceipts === round.totalReceipts
  && (!round.settled || round.buybackCompleted));
const zeroReceiptCleanup = rounds.filter((round) => round.totalReceipts === 0
  && (round.settled || clock >= round.refundAt));
const onchainReceiptDeficits = rounds.filter((round) => round.processedReceipts < round.totalReceipts);
const excessRounds = rounds.filter((round) => round.excess > 0).map((round) => ({
  id: round.id,
  excessLamports: round.excess,
  settled: round.settled,
  receipts: `${round.processedReceipts}/${round.totalReceipts}`,
  claimedLamports: round.claimedLamports,
  prizeLamports: round.prizeLamports,
  motherlodePayoutLamports: round.motherlodePayoutLamports,
}));

console.log(JSON.stringify({
  genesisHash,
  slotTime: clock,
  config: {
    address: configAddress.toBase58(),
    version: Number(config.version),
    paused: Boolean(config.paused),
    admin: config.admin.toBase58(),
    randomnessAuthority: config.randomnessAuthority.toBase58(),
    buybackWallet: config.buybackWallet.toBase58(),
    randomnessProgram: config.randomnessProgram.toBase58(),
  },
  currentRound,
  roundAccounts: rounds.length,
  roundRentLamports: sum(rounds, 'rent').toString(),
  roundExcessLamports: sum(rounds, 'excess').toString(),
  receiptAccounts: receipts.length,
  unprocessedReceipts: unprocessed.length,
  processedOpenReceipts: processedOpen.length,
  receiptRentLamports: sum(receipts, 'rent').toString(),
  processedReceiptRentLamports: sum(processedOpen, 'rent').toString(),
  unprocessedReceiptRounds: [...new Set(unprocessed.map((receipt) => receipt.roundId))].sort((a, b) => a - b),
  onchainReceiptDeficits: onchainReceiptDeficits.map((round) => ({
    id: round.id,
    total: round.totalReceipts,
    processed: round.processedReceipts,
  })),
  excessRounds,
  beneficiaryPendingSolLamports: stakes.reduce((total, stake) => total + BigInt(stake.pendingSol), 0n).toString(),
  beneficiaryPendingSol: stakes.filter((stake) => BigInt(stake.pendingSol) > 0n),
  archiveEligibleRoundIds: archiveEligible.map((round) => round.id),
  closeEligibleRoundIds: closeEligible.map((round) => round.id),
  zeroReceiptCleanupRoundIds: zeroReceiptCleanup.map((round) => round.id),
  randomnessAccounts: randomness.length,
  randomnessLamports: sum(randomness, 'lamports').toString(),
  rentPayers: [...new Set(rounds.map((round) => round.rentPayer))],
}, null, 2));
