import { AnchorProvider, BN, BorshAccountsCoder, Program } from '@anchor-lang/core';
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';

import idl from '../generated/myne_protocol.json';
import { PROGRAMS } from '../app-config.js';
import { NETWORK } from '../app-config.js';
import { connection } from './client.js';
import { capabilitiesFromIdl } from './protocol-capabilities.js';

const PROGRAM_ID = PROGRAMS.protocol ? new PublicKey(PROGRAMS.protocol) : null;
const coder = new BorshAccountsCoder(idl);
const text = (value) => new TextEncoder().encode(value);
const camelize = (value) => {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== 'object' || value instanceof PublicKey || BN.isBN(value) || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), camelize(nested),
  ]));
};

export const protocolCapabilities = Object.freeze(capabilitiesFromIdl(idl));

export const deriveProtocolConfigPda = () => PROGRAM_ID
  ? PublicKey.findProgramAddressSync([text('config')], PROGRAM_ID)[0]
  : null;

export const protocolProgramId = PROGRAM_ID;
export const asBn = (value) => new BN(String(value));
export const u64Seed = (value) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
};
export const derivePda = (...seeds) => {
  if (!PROGRAM_ID) throw new Error('MYNE program ID is not configured');
  return PublicKey.findProgramAddressSync(seeds.map((seed) => (
    typeof seed === 'string' ? text(seed) : seed instanceof PublicKey ? seed.toBytes() : seed
  )), PROGRAM_ID)[0];
};
export const protocolPdas = Object.freeze({
  config: deriveProtocolConfigPda(),
  miningPool: PROGRAM_ID ? derivePda('mining_pool') : null,
  stakePool: PROGRAM_ID ? derivePda('stake_pool') : null,
  liquidityGate: PROGRAM_ID ? derivePda('liquidity_gate') : null,
});

// Protocol configuration changes only through an admin transaction, so avoid fetching the same
// PDA for every page refresh. A short TTL keeps normal admin updates visible without adding a
// subscription requirement to the read-only client.
const CONFIG_CACHE_MS = 15_000;
let configCache = null;
let configCacheAt = 0;
let configRequest = null;
const SWITCHBOARD_MAINNET_PROGRAM = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';

function assertDeploymentMatchesConfig(config) {
  if (PROGRAMS.tokenMint && !new PublicKey(config.mint).equals(new PublicKey(PROGRAMS.tokenMint))) {
    throw new Error('Configured MYNE mint does not match the on-chain protocol config');
  }
  if (PROGRAMS.randomness && !new PublicKey(config.randomnessProgram).equals(new PublicKey(PROGRAMS.randomness))) {
    throw new Error('Configured randomness program does not match the on-chain protocol config');
  }
  if (NETWORK.cluster === 'mainnet-beta'
      && !new PublicKey(config.randomnessProgram).equals(new PublicKey(SWITCHBOARD_MAINNET_PROGRAM))) {
    throw new Error('On-chain protocol is not locked to Switchboard mainnet randomness');
  }
  return config;
}

export async function fetchProtocolAccount(name, address) {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) return null;
  return decodeProtocolAccount(name, info.data);
}

export const decodeProtocolAccount = (name, data) => camelize(coder.decode(name, data));

export async function getProtocolConfig({ force = false } = {}) {
  if (!protocolPdas.config) throw new Error('MYNE program ID is not configured');
  if (!force && configCache && Date.now() - configCacheAt < CONFIG_CACHE_MS) return configCache;
  if (!configRequest) {
    configRequest = fetchProtocolAccount('ProtocolConfig', protocolPdas.config)
      .then((config) => {
        if (!config) throw new Error('Protocol config is not initialized');
        assertDeploymentMatchesConfig(config);
        configCache = config;
        configCacheAt = Date.now();
        return config;
      })
      .finally(() => { configRequest = null; });
  }
  return configRequest;
}

export const invalidateProtocolConfig = () => {
  configCache = null;
  configCacheAt = 0;
};

async function walletAdapter() {
  const { getAccount, getProvider } = await import('./client.js');
  const provider = getProvider();
  const account = getAccount();
  if (!provider || !account) throw new Error('Connect a Solana wallet first');
  return {
    publicKey: new PublicKey(account),
    signTransaction: (transaction) => provider.signTransaction(transaction),
    signAllTransactions: provider.signAllTransactions
      ? (transactions) => provider.signAllTransactions(transactions)
      : (transactions) => Promise.all(transactions.map((transaction) => provider.signTransaction(transaction))),
    provider,
  };
}

export async function getWritableProgram() {
  const wallet = await walletAdapter();
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  return { program: new Program(idl, provider), provider, wallet };
}

export async function sendInstructions(instructions) {
  const { wallet } = await getWritableProgram();
  const latest = await connection.getLatestBlockhash('confirmed');
  const simulationTransaction = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...instructions,
  );
  const simulation = await connection.simulateTransaction(simulationTransaction, {
    sigVerify: false,
  });
  if (simulation.value.err) {
    throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  const measuredUnits = Number(simulation.value.unitsConsumed || 200_000);
  const computeUnits = Math.min(1_400_000, Math.max(50_000, Math.ceil(measuredUnits * 1.1)));
  const priorityMicrolamports = Math.max(0, Math.min(
    1_000_000,
    Number(import.meta.env?.VITE_PRIORITY_FEE_MICROLAMPORTS || 0),
  ));
  const transaction = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ...(priorityMicrolamports > 0
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicrolamports })]
      : []),
    ...instructions,
  );
  let signature;
  if (wallet.provider.signAndSendTransaction) {
    const result = await wallet.provider.signAndSendTransaction(transaction);
    signature = typeof result === 'string' ? result : result.signature;
  } else {
    const signed = await wallet.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize());
  }
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Transaction failed after submission: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

export async function readProtocolStatus() {
  if (!PROGRAM_ID) {
    return { connected: false, reason: 'VITE_MYNE_PROGRAM_ID is not configured', capabilities: protocolCapabilities };
  }

  const configPda = deriveProtocolConfigPda();
  const [slot, programAccount, configAccount] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getAccountInfo(PROGRAM_ID, 'confirmed'),
    connection.getAccountInfo(configPda, 'confirmed'),
  ]);
  if (!programAccount?.executable) {
    return { connected: false, reason: 'Program is not executable on this cluster', slot, capabilities: protocolCapabilities };
  }
  if (!configAccount) {
    return { connected: false, reason: 'Protocol config is not initialized', slot, capabilities: protocolCapabilities };
  }
  if (!configAccount.owner.equals(PROGRAM_ID)) throw new Error('Protocol config has the wrong owner');

  const config = coder.decode('ProtocolConfig', configAccount.data);
  if (!config.mint) throw new Error('Decoded protocol config is missing its mint');
  assertDeploymentMatchesConfig(config);
  return {
    connected: true,
    slot,
    programId: PROGRAM_ID,
    configPda,
    config,
    capabilities: protocolCapabilities,
  };
}
