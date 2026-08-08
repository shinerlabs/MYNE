import { PublicKey } from 'npm:@solana/web3.js@1.98.4';

const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MYNE_PROGRAM_ID = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const MYNE_MINT_ADDRESS = 'BcpJWJpL82D8qdcdb1RoP3TAfD3TKL9fJkpvHw1QWUWt';
const UPGRADEABLE_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_ACCOUNT_SIZE = 165;
const MAX_TOKEN_ACCOUNTS = 97;
const BALANCE_CACHE_MS = 10_000;
const MAX_U64 = (1n << 64n) - 1n;

export const CHAT_MIN_MYNE_BASE_UNITS = 10_000_000n; // 0.01 MYNE at 9 decimals.

const MINING_POOL_DISCRIMINATOR = Uint8Array.from([134, 149, 193, 160, 11, 139, 229, 253]);
const MINER_DISCRIMINATOR = Uint8Array.from([223, 113, 15, 54, 123, 122, 140, 100]);
const STAKE_POSITION_DISCRIMINATOR = Uint8Array.from([78, 165, 30, 111, 171, 125, 11, 220]);

type JsonRecord = Record<string, unknown>;
type RpcAccount = {
  data: [string, string];
  executable: boolean;
  owner: string;
};
type Deployment = {
  genesisHash: string;
  mint: PublicKey;
  program: PublicKey;
  rpcUrl: string;
};

export type MyneChatBalance = {
  burnStakeBaseUnits: bigint;
  cooldownStakeBaseUnits: bigint;
  eligible: boolean;
  liquidBaseUnits: bigint;
  miningRewardsBaseUnits: bigint;
  standardStakeBaseUnits: bigint;
  totalBaseUnits: bigint;
};

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonicalPublicKey = (value: string, label: string): PublicKey => {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new Error(`${label} is not a canonical Solana public key`);
  }
};

const configuredDeployment = (): Deployment => {
  const rpcUrl = Deno.env.get('CHAT_SOLANA_RPC_URL')?.trim();
  if (!rpcUrl) throw new Error('CHAT_SOLANA_RPC_URL is required');
  const parsed = new URL(rpcUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new Error('CHAT_SOLANA_RPC_URL must use HTTPS outside loopback development');
  }
  return {
    rpcUrl: parsed.toString(),
    genesisHash: canonicalPublicKey(
      Deno.env.get('CHAT_SOLANA_GENESIS_HASH')?.trim() || MAINNET_GENESIS_HASH,
      'CHAT_SOLANA_GENESIS_HASH',
    ).toBase58(),
    program: canonicalPublicKey(
      Deno.env.get('CHAT_MYNE_PROGRAM_ID')?.trim() || MYNE_PROGRAM_ID,
      'CHAT_MYNE_PROGRAM_ID',
    ),
    mint: canonicalPublicKey(
      Deno.env.get('CHAT_MYNE_MINT_ADDRESS')?.trim() || MYNE_MINT_ADDRESS,
      'CHAT_MYNE_MINT_ADDRESS',
    ),
  };
};

let rpcId = 0;
const rpc = async <T>(deployment: Deployment, method: string, params: unknown[]): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(deployment.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.error || !('result' in payload)) {
      throw new Error(`RPC ${method} failed`);
    }
    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
};

const decodeBase64 = (value: unknown): Uint8Array => {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || value[1] !== 'base64') {
    throw new Error('RPC account data is not canonical base64');
  }
  const binary = atob(value[0]);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (btoa(binary) !== value[0]) throw new Error('RPC account data is non-canonical base64');
  return bytes;
};

const readU64 = (data: Uint8Array, offset: number): bigint => {
  if (offset + 8 > data.length) throw new Error('Account is shorter than its u64 field');
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index]);
  return value;
};

const readU128 = (data: Uint8Array, offset: number): bigint => {
  if (offset + 16 > data.length) throw new Error('Account is shorter than its u128 field');
  let value = 0n;
  for (let index = 15; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index]);
  return value;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const decodeProgramAccount = (
  account: RpcAccount | null,
  deployment: Deployment,
  discriminator: Uint8Array,
  minimumLength: number,
  label: string,
): Uint8Array | null => {
  if (!account) return null;
  if (account.executable || account.owner !== deployment.program.toBase58()) {
    throw new Error(`${label} has an invalid owner or executable flag`);
  }
  const data = decodeBase64(account.data);
  if (data.length < minimumLength || !equalBytes(data.slice(0, 8), discriminator)) {
    throw new Error(`${label} has an invalid layout or discriminator`);
  }
  return data;
};

const assertAuthority = (data: Uint8Array, wallet: PublicKey, label: string): void => {
  if (!equalBytes(data.slice(9, 41), wallet.toBytes())) throw new Error(`${label} authority does not match wallet`);
};

let deploymentKey = '';
let deploymentPromise: Promise<Deployment> | null = null;
const verifyDeployment = async (): Promise<Deployment> => {
  const deployment = configuredDeployment();
  const key = [deployment.rpcUrl, deployment.genesisHash, deployment.program, deployment.mint].join('|');
  if (deploymentPromise && deploymentKey === key) return deploymentPromise;
  deploymentKey = key;
  deploymentPromise = (async () => {
    const genesisHash = await rpc<string>(deployment, 'getGenesisHash', []);
    if (genesisHash !== deployment.genesisHash) throw new Error('RPC genesis does not match configured Solana cluster');
    const result = await rpc<{ value: Array<RpcAccount | null> }>(deployment, 'getMultipleAccounts', [
      [deployment.program.toBase58(), deployment.mint.toBase58()],
      { encoding: 'base64', commitment: 'finalized' },
    ]);
    if (!result || !Array.isArray(result.value) || result.value.length !== 2) {
      throw new Error('Could not verify MYNE deployment accounts');
    }
    const [programAccount, mintAccount] = result.value;
    if (!programAccount?.executable || programAccount.owner !== UPGRADEABLE_LOADER_ID) {
      throw new Error('Configured MYNE program is not an executable upgradeable program');
    }
    if (!mintAccount || mintAccount.executable || mintAccount.owner !== TOKEN_PROGRAM_ID) {
      throw new Error('Configured MYNE mint is not owned by the SPL Token program');
    }
    const mintData = decodeBase64(mintAccount.data);
    if (mintData.length !== 82 || mintData[44] !== 9 || mintData[45] !== 1) {
      throw new Error('Configured MYNE mint has an invalid legacy SPL Mint layout');
    }
    return deployment;
  })().catch((error) => {
    deploymentPromise = null;
    throw error;
  });
  return deploymentPromise;
};

const decodeTokenBalance = (account: RpcAccount | null, deployment: Deployment, wallet: PublicKey): bigint => {
  if (!account || account.executable || account.owner !== TOKEN_PROGRAM_ID) {
    throw new Error('MYNE token account has an invalid owner or executable flag');
  }
  const data = decodeBase64(account.data);
  if (data.length !== TOKEN_ACCOUNT_SIZE
    || !equalBytes(data.slice(0, 32), deployment.mint.toBytes())
    || !equalBytes(data.slice(32, 64), wallet.toBytes())
    || data[108] === 0) {
    throw new Error('MYNE token account has an invalid layout, mint, wallet, or state');
  }
  return readU64(data, 64);
};

const readUncachedBalance = async (walletAddress: string): Promise<MyneChatBalance> => {
  const deployment = await verifyDeployment();
  const wallet = canonicalPublicKey(walletAddress, 'wallet address');
  const [miningPool] = PublicKey.findProgramAddressSync([new TextEncoder().encode('mining_pool')], deployment.program);
  const [miner] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('miner'), wallet.toBytes()],
    deployment.program,
  );
  const [stakePosition] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('stake_position'), wallet.toBytes()],
    deployment.program,
  );

  const tokenResult = await rpc<{ context: { slot: number }; value: Array<{ pubkey: string }> }>(
    deployment,
    'getTokenAccountsByOwner',
    [
      wallet.toBase58(),
      { mint: deployment.mint.toBase58() },
      { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 0 } },
    ],
  );
  if (!tokenResult || !Number.isSafeInteger(tokenResult.context?.slot) || !Array.isArray(tokenResult.value)) {
    throw new Error('Could not enumerate MYNE token accounts');
  }
  if (tokenResult.value.length > MAX_TOKEN_ACCOUNTS) throw new Error('Wallet has too many MYNE token accounts');
  const tokenAddresses = tokenResult.value.map(({ pubkey }) => canonicalPublicKey(pubkey, 'token account').toBase58());
  if (new Set(tokenAddresses).size !== tokenAddresses.length) throw new Error('RPC returned duplicate MYNE token accounts');

  const addresses = [miningPool.toBase58(), miner.toBase58(), stakePosition.toBase58(), ...tokenAddresses];
  const snapshot = await rpc<{ context: { slot: number }; value: Array<RpcAccount | null> }>(
    deployment,
    'getMultipleAccounts',
    [
      addresses,
      { encoding: 'base64', commitment: 'finalized', minContextSlot: tokenResult.context.slot },
    ],
  );
  if (!snapshot
    || !Number.isSafeInteger(snapshot.context?.slot)
    || snapshot.context.slot < tokenResult.context.slot
    || !Array.isArray(snapshot.value)
    || snapshot.value.length !== addresses.length) {
    throw new Error('Could not read a coherent MYNE balance snapshot');
  }

  const miningPoolData = decodeProgramAccount(
    snapshot.value[0], deployment, MINING_POOL_DISCRIMINATOR, 41, 'MiningPool',
  );
  if (!miningPoolData) throw new Error('MiningPool account is missing');
  const totalUnclaimed = readU64(miningPoolData, 9);
  const totalShares = readU128(miningPoolData, 17);

  let miningRewardsBaseUnits = 0n;
  const minerData = decodeProgramAccount(snapshot.value[1], deployment, MINER_DISCRIMINATOR, 121, 'Miner');
  if (minerData) {
    assertAuthority(minerData, wallet, 'Miner');
    const minerShares = readU128(minerData, 81);
    if (totalShares > 0n && minerShares > totalShares) throw new Error('Miner shares exceed total shares');
    if (totalShares > 0n) miningRewardsBaseUnits = (totalUnclaimed * minerShares) / totalShares;
  }

  let standardStakeBaseUnits = 0n;
  let burnStakeBaseUnits = 0n;
  let cooldownStakeBaseUnits = 0n;
  const stakeData = decodeProgramAccount(
    snapshot.value[2], deployment, STAKE_POSITION_DISCRIMINATOR, 105, 'StakePosition',
  );
  if (stakeData) {
    assertAuthority(stakeData, wallet, 'StakePosition');
    standardStakeBaseUnits = readU64(stakeData, 41);
    burnStakeBaseUnits = readU64(stakeData, 49);
    cooldownStakeBaseUnits = readU64(stakeData, 89);
  }

  const liquidBaseUnits = snapshot.value
    .slice(3)
    .reduce((total, account) => total + decodeTokenBalance(account, deployment, wallet), 0n);
  const values = [liquidBaseUnits, miningRewardsBaseUnits, standardStakeBaseUnits, burnStakeBaseUnits, cooldownStakeBaseUnits];
  if (values.some((value) => value < 0n || value > MAX_U64)) throw new Error('MYNE balance component is out of range');
  const totalBaseUnits = values.reduce((total, value) => total + value, 0n);

  return {
    liquidBaseUnits,
    miningRewardsBaseUnits,
    standardStakeBaseUnits,
    burnStakeBaseUnits,
    cooldownStakeBaseUnits,
    totalBaseUnits,
    eligible: totalBaseUnits >= CHAT_MIN_MYNE_BASE_UNITS,
  };
};

const balanceCache = new Map<string, { expiresAt: number; promise: Promise<MyneChatBalance> }>();

export const readMyneChatBalance = (walletAddress: string): Promise<MyneChatBalance> => {
  const wallet = canonicalPublicKey(walletAddress, 'wallet address').toBase58();
  const cached = balanceCache.get(wallet);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = readUncachedBalance(wallet).catch((error) => {
    balanceCache.delete(wallet);
    throw error;
  });
  balanceCache.set(wallet, { expiresAt: Date.now() + BALANCE_CACHE_MS, promise });
  return promise;
};
