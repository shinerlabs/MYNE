import { NETWORK, PROGRAMS, PROTOCOL_READY } from '../app-config.js';

/** Solana-native frontend configuration. Program data is supplied after deployment. */
export const solanaNetwork = Object.freeze({
  name: ({
    localnet: 'Solana Localnet',
    devnet: 'Solana Devnet',
    testnet: 'Solana Testnet',
    'mainnet-beta': 'Solana Mainnet',
  })[NETWORK.cluster] || `Solana ${NETWORK.cluster}`,
  cluster: NETWORK.cluster,
  rpcUrl: NETWORK.rpcUrl,
  blockExplorers: { default: { name: 'Solana Explorer', url: NETWORK.explorerUrl } },
});

export const addresses = Object.freeze({
  MyneMint: PROGRAMS.tokenMint,
  MyneProgram: PROGRAMS.protocol,
});
const ENV = import.meta.env ?? {};
export let genesisTime = BigInt(ENV.VITE_GENESIS_TIME || Math.floor(Date.now() / 1000));
export const setGenesisTime = (value) => { genesisTime = BigInt(value); };
export const economics = Object.freeze({
  protocolFeeBps: 1200, stakingBps: 800, stakingAdminShareBps: 1000,
  stakingNetBps: 720, buybackBps: 100, motherlodeBps: 200,
  administrationBps: 100, liquidityPoolTaxBps: 0,
  minimumRoundLamports: '50000000', stakingRewardAsset: 'SOL',
});
export const MIN_ROUND_DEPLOYMENT = BigInt(economics.minimumRoundLamports);
// Solana launches with one simple allocation: 100 MYNE minted and all 100 available for the
// initial liquidity pool. There is no protocol-owned or pre-existing burn-staked balance.
export const launchAllocation = Object.freeze({ genesisMintMyne: 100, burnStakedMyne: 0, liquidityMyne: 100, initialMarketMyne: 100 });
export const poolKey = null;
export const poolId = null;
export const dexscreenerUrl = null;
export const stockRewards = null;
export const hasPool = false;
// The Solana release starts directly in its live mining phase. This flag remains exported while
// the inherited UI branches are retired, but must never put this frontend into a pre-mine state.
export const isPremine = false;
export const protocolReady = PROTOCOL_READY;
export const GRID = 25;
export const ROUND_DURATION = 65n;
export const BETTING_DURATION = 60n;
export const RESOLUTION_COUNTDOWN_DURATION = 0n;
export const WINNER_DISPLAY_DURATION = 5n;
export const ACCOUNT_DEPOSIT = 100000n; // 0.0001 SOL

const clusterQuery = NETWORK.cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(NETWORK.cluster)}`;
export const explorerTx = (signature) => `${NETWORK.explorerUrl}/tx/${signature}${clusterQuery}`;
export const explorerAddress = (address) => address ? `${NETWORK.explorerUrl}/address/${address}${clusterQuery}` : '#';
