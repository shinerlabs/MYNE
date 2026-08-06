import { keccak256, encodeAbiParameters, encodePacked } from 'viem';
import { addresses, abis, poolKey, uniswap } from './config.js';
import { publicClient, getWalletClient, getAccount, withGasHeadroom } from './client.js';

/**
 * SOL <-> MYNE swaps on Uniswap V4, through the CANONICAL Universal Router.
 *
 * Trading fees are deferred. This adapter, when enabled for a future pool, quotes the venue's
 * native LP fee only; it does not collect a protocol buy/sell tax.
 *
 * WHY NOT THE UNISWAP APP: Uniswap Labs' routing API only routes through hooks on its allowlist,
 * so app.uniswap.org reports "No routes available" for this pool even though it trades perfectly.
 * Reaching the pool directly through the Universal Router is what makes MYNE tradeable on our own
 * site regardless of that decision.
 *
 * WHAT THIS REPLACES: `BullionSwapRouter`, a PoolSwapTest subclass from the deleted testnet fork.
 * It does not exist on mainnet, and v4-core's test routers must never carry user funds.
 *
 * EXACT-INPUT ONLY. BullionTaxHook reverts on exact-output (`amountSpecified > 0`) so the SOL leg
 * cannot be gamed to escape the tax — there is deliberately no exact-output path here.
 *
 * APPROVALS ARE TWO HOPS for sells: MYNE -> Permit2 (ERC20 allowance), then Permit2 -> Universal
 * Router (time-boxed). `readSwapState` reports the EFFECTIVE allowance (the smaller of the two) and
 * `approveGld` fills whichever hop is short, so callers still see one number and one action.
 */
const token = { address: addresses.BullionToken, abi: abis.token };

const Q96 = 2n ** 96n;
// LP fee taken from the POOL KEY, not hardcoded. `fee` is in hundredths of a bip (3000 = 0.30%),
// so the swap keeps (1e6 - fee)/1e6. This was pinned at 997/1000 and would have silently
// under-quoted on any pool that is not exactly 0.30% — including a fee-0 pool, where the protocol
// takes everything and the LP fee is nil.
const FEE_DEN = 1_000_000n;
const FEE_NUM = FEE_DEN - BigInt(poolKey?.fee ?? 3000);

// Universal Router command (Commands.sol) + v4-periphery actions (Actions.sol).
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
];

const STATE_VIEW_ABI = [
  {
    type: 'function', name: 'getSlot0', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function', name: 'getLiquidity', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
];

const PERMIT2_ABI = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
];

const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
];

// PHASE 1 (premine) ships with NO pool, so `poolKey` is null. This runs at MODULE SCOPE —
// computing it unguarded throws during import, which takes the whole app down (blank page), not
// just the swap surface. Guard it and let the exported calls fail loudly instead.
const poolId = poolKey
  ? keccak256(encodeAbiParameters([{ type: 'tuple', components: POOL_KEY_COMPONENTS }], [poolKey]))
  : null;

const router = uniswap?.universalRouter;
const permit2 = uniswap?.permit2;
const stateView = uniswap?.stateView;

export const poolAvailable = Boolean(poolKey && router && permit2 && stateView);
const noPool = () => {
  throw new Error('Swapping opens when liquidity is added — there is no SOL/MYNE pool yet.');
};

/** Live pool sqrtPrice + liquidity, plus the connected account's balances and effective allowance. */
export async function readSwapState(account = getAccount()) {
  if (!poolAvailable) noPool();

  // StateView is the SUPPORTED read path. This used to hand-compute keccak256(poolId ++ 6) and
  // read PoolManager.extsload directly — correct, but POOLS_SLOT is a v4-core internal, and if it
  // ever moves the quote silently reads zero and the UI shows an empty pool.
  const [slot0, liquidity] = await publicClient.multicall({
    contracts: [
      { address: stateView, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] },
      { address: stateView, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] },
    ],
    allowFailure: false,
  });
  const sqrtPriceX96 = BigInt(slot0[0]);

  let gldBalance = 0n, solBalance = 0n, allowance = 0n;
  if (account) {
    const [bal, erc20Allow, permitAllow, eth] = await Promise.all([
      publicClient.readContract({ ...token, functionName: 'balanceOf', args: [account] }),
      publicClient.readContract({ ...token, functionName: 'allowance', args: [account, permit2] }),
      publicClient.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, token.address, router] }),
      publicClient.getBalance({ address: account }),
    ]);
    gldBalance = bal;
    solBalance = eth;
    // Two hops must BOTH be funded, and the Permit2 leg also expires. Report the binding one so a
    // caller comparing `allowance < amountIn` keeps working unchanged.
    const [permitAmount, expiration] = permitAllow;
    const permitUsable = Number(expiration) * 1000 > Date.now() ? permitAmount : 0n;
    allowance = erc20Allow < permitUsable ? erc20Allow : permitUsable;
  }
  return { sqrtPriceX96, liquidity: BigInt(liquidity), gldBalance, solBalance, allowance };
}

// --- exact single-tick swap math (SqrtPriceMath) ------------------------------------------------

/** token0 (SOL) exact-in -> token1 (MYNE) out. Price falls as SOL is added. */
function amount1Out(amountIn0, sqrtP, L) {
  if (amountIn0 <= 0n || L <= 0n || sqrtP <= 0n) return 0n;
  const sqrtPnew = (L * sqrtP * Q96) / (L * Q96 + amountIn0 * sqrtP);
  return (L * (sqrtP - sqrtPnew)) / Q96;
}

/** token1 (MYNE) exact-in -> token0 (SOL) out. Price rises as MYNE is added. */
function amount0Out(amountIn1, sqrtP, L) {
  if (amountIn1 <= 0n || L <= 0n || sqrtP <= 0n) return 0n;
  const sqrtPnew = sqrtP + (amountIn1 * Q96) / L;
  return (L * (sqrtPnew - sqrtP) * Q96) / (sqrtP * sqrtPnew);
}

/**
 * Estimate the output for `amountIn` in the given direction, net of the venue LP fee.
 * @param dir 'buy' (SOL->MYNE) or 'sell' (MYNE->SOL)
 */
export function quote(amountIn, dir, { sqrtPriceX96, liquidity }) {
  if (amountIn <= 0n || !sqrtPriceX96) return 0n;
  if (dir === 'buy') {
    const solLessFee = (amountIn * FEE_NUM) / FEE_DEN;
    return amount1Out(solLessFee, sqrtPriceX96, liquidity);
  }
  const gldLessFee = (amountIn * FEE_NUM) / FEE_DEN;          // pool's LP fee on MYNE in
  const solGross = amount0Out(gldLessFee, sqrtPriceX96, liquidity);
  return solGross;
}

/** Spot price as MYNE per SOL (for the "Rate" display). */
export function spotMynePerSol({ sqrtPriceX96 }) {
  if (!sqrtPriceX96) return 0;
  const r = Number(sqrtPriceX96) / Number(Q96);
  return r * r;
}

/** minOut with a slippage tolerance in bps. Now enforced ON CHAIN via SWAP_EXACT_IN_SINGLE. */
export const withSlippage = (out, slippageBps = 100) => (out * BigInt(10000 - slippageBps)) / 10000n;

// --- transactions -------------------------------------------------------------------------------

/**
 * Authorise `amount` MYNE for selling. Fills whichever of the two hops is short:
 *   1. MYNE -> Permit2   (plain ERC20 approve)
 *   2. Permit2 -> Universal Router  (amount + 30-day expiry)
 * Returns the last transaction hash, or null when both hops were already funded.
 */
export async function approveGld(amount) {
  if (!poolAvailable) noPool();
  const account = getAccount();
  const wallet = getWalletClient();
  let hash = null;

  const erc20Allow = await publicClient.readContract({ ...token, functionName: 'allowance', args: [account, permit2] });
  if (erc20Allow < amount) {
    hash = await wallet.writeContract(await withGasHeadroom({
      ...token, functionName: 'approve', args: [permit2, amount], account,
    }));
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const [permitAmount, expiration] = await publicClient.readContract({
    address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, token.address, router],
  });
  const permitLive = Number(expiration) * 1000 > Date.now() && permitAmount >= amount;
  if (!permitLive) {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    hash = await wallet.writeContract(await withGasHeadroom({
      address: permit2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [token.address, router, amount, expiry], account,
    }));
  }
  return hash;
}

/**
 * Encode one exact-input V4 swap for the Universal Router.
 * V4_SWAP wraps three actions: do the swap, pay the input, collect the output.
 */
function encodeSwap({ zeroForOne, amountIn, minOut }) {
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const swapParams = encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{ poolKey, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }],
  );
  const inCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inCurrency, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outCurrency, minOut]);
  return {
    commands: encodePacked(['uint8'], [V4_SWAP]),
    inputs: [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]])],
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
  };
}

/** Buy MYNE with `solIn` SOL. `minOut` is enforced on chain — pass one. */
export async function swapSolForGld(solIn, minOut = 0n) {
  if (!poolAvailable) noPool();
  const { commands, inputs, deadline } = encodeSwap({ zeroForOne: true, amountIn: solIn, minOut });
  return getWalletClient().writeContract(await withGasHeadroom({
    address: router, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
    args: [commands, inputs, deadline], value: solIn, account: getAccount(),
  }));
}

/** Sell `gldIn` MYNE for SOL. `minOut` is enforced on chain — pass one. */
export async function swapGldForSol(gldIn, minOut = 0n) {
  if (!poolAvailable) noPool();
  const { commands, inputs, deadline } = encodeSwap({ zeroForOne: false, amountIn: gldIn, minOut });
  return getWalletClient().writeContract(await withGasHeadroom({
    address: router, abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute',
    args: [commands, inputs, deadline], account: getAccount(),
  }));
}
