# Frontend migration map

The current frontend is safe only because protocol actions remain disabled while program and mint
addresses are empty. Most files below still describe the inherited EVM contracts and cannot be
activated against Solana.

| Frontend module | Current inherited assumptions | Solana replacement |
| --- | --- | --- |
| `chain/lottery.js` | ABI reads, multicall, payable bets, EVM logs | Anchor Round/BetReceipt account decoders and instructions |
| `chain/staking.js` | ERC-20 allowance, EVM reward logs, Uniswap state | SPL token CPI instructions, stake PDAs and SOL vault accumulator |
| `chain/referral.js` | address mappings and EVM event enumeration | Miner/referral PDAs plus indexer queries |
| `chain/swap.js` | Uniswap v4 pool, Permit2, universal router | chosen Solana liquidity venue integration; not yet selected |
| `chain/autocommit.js` | contract-held plan balance and delegate | separate keeper design with capped delegate/session authority |
| `chain/supply.js` | ERC-20 total supply and burn event scan | SPL mint supply plus indexed burn events |
| `chain/client.js` | Solana wallet discovery but disabled EVM proxy | Anchor 1.0 client/provider and versioned transactions |

## Migration order

1. **Complete for the configuration milestone:** build the Anchor program and sync its generated IDL
   into `Frontend/src/generated` with `pnpm run sync:solana`.
2. **In progress:** the pinned Anchor 1.0 browser client validates and decodes the config PDA; wallet
   transaction construction remains pending until user-facing instructions exist.
3. **Config complete; round/miner pending:** the main app shows live localnet config health and derives
   feature availability from the actual IDL.
4. Implement mining deployment and claim transactions on localnet.
5. Add indexed history/leaderboards without making the indexer authoritative for balances.
6. Add staking and referrals after their program modules and tests are complete.
7. Integrate swaps only after the DEX-specific 4% SOL tax design is resolved.
8. Remove `viem`, EVM ABIs, `src/deployments/4663.json`, and every legacy proxy call.

## Frontend invariants

- Every transaction shows the exact program ID, mint and cluster in diagnostics.
- No production action is enabled merely because an RPC is reachable.
- IDL account discriminators and program ownership are checked before decoding.
- The indexer can accelerate history but cannot decide claimability or balances.
- SOL uses lamports and MYNE uses mint base units; no `wei`, `ether`, WAD, Permit2, gas or EVM
  address language remains in the finished adapter.
