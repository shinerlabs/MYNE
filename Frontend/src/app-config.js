/**
 * Product and network identity live here so the working name can be replaced
 * without hunting through the application. Protocol identifiers deliberately
 * remain empty until the Solana programs and SPL mint are deployed.
 */
const ENV = import.meta.env ?? {};
const SWITCHBOARD_MAINNET_PROGRAM = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';

export const PRODUCT = Object.freeze({
  name: ENV.VITE_PRODUCT_NAME || 'MYNE',
  tokenName: ENV.VITE_TOKEN_NAME || 'MYNE',
  tokenSymbol: ENV.VITE_TOKEN_SYMBOL || 'MYNE',
});

export const NETWORK = Object.freeze({
  cluster: ENV.VITE_SOLANA_CLUSTER || 'devnet',
  rpcUrl: ENV.VITE_SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  explorerUrl: ENV.VITE_SOLANA_EXPLORER_URL || 'https://explorer.solana.com',
});

export const PROGRAMS = Object.freeze({
  protocol: ENV.VITE_MYNE_PROGRAM_ID || ENV.VITE_SOLANA_PROGRAM_ID || '',
  tokenMint: ENV.VITE_MYNE_MINT_ADDRESS || ENV.VITE_GLD_MINT_ADDRESS || '',
  randomness: ENV.VITE_MYNE_RANDOMNESS_PROGRAM_ID || '',
  upgradeAuthority: ENV.VITE_MYNE_UPGRADE_AUTHORITY || '',
});

export const SERVICES = Object.freeze({
  indexerUrl: ENV.VITE_MYNE_INDEXER_URL || '',
});

export const LINKS = Object.freeze({
  telegram: ENV.VITE_TELEGRAM_URL || '',
  x: ENV.VITE_X_URL || '',
});

export const DEPLOYMENT_CONFIG_ERRORS = Object.freeze([
  ...(NETWORK.cluster === 'mainnet-beta' && !/^https:\/\//.test(NETWORK.rpcUrl)
    ? ['Mainnet RPC must use HTTPS'] : []),
  ...(NETWORK.cluster === 'mainnet-beta' && /devnet|testnet|localhost|127\.0\.0\.1/i.test(NETWORK.rpcUrl)
    ? ['Mainnet frontend is configured with a non-mainnet RPC'] : []),
  ...(NETWORK.cluster === 'mainnet-beta' && PROGRAMS.randomness !== SWITCHBOARD_MAINNET_PROGRAM
    ? ['Mainnet frontend must pin the Switchboard mainnet program'] : []),
  ...(NETWORK.cluster === 'mainnet-beta' && !PROGRAMS.tokenMint
    ? ['Mainnet MYNE mint is not configured'] : []),
]);

// Transaction modules stay fail-closed until every required instruction exists in the generated
// IDL. The configuration milestone is connected separately through chain/anchor-client.js.
export const PROTOCOL_READY = Boolean(PROGRAMS.protocol) && DEPLOYMENT_CONFIG_ERRORS.length === 0;
