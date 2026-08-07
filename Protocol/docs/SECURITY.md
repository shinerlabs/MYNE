# Security and deployment gates

No MYNE program should reach mainnet until every gate below is satisfied.

## Development gates

- Pin Rust, Solana/Agave, Anchor CLI and Anchor crate versions.
- Generate a unique program keypair; run `anchor keys sync`; verify every declared ID.
- Run unit, integration, property and adversarial tests locally.
- Test checked arithmetic at `u64` boundaries and every basis-point rounding path.
- Prove version-6 fee conservation for every round: 8% gross staking becomes 0.8% direct admin plus
  7.2% net stakers, alongside 2% Motherlode, 1% buyback and 1% direct admin; total fee is exactly
  12%, and all rounding dust is emitted and routed by the documented rule.
- Test duplicate accounts, wrong PDAs, wrong mint/token program, signer substitution and replay.
- Test pause behavior while ensuring withdrawals and already-earned claims remain recoverable.
- Test oracle replay, duplicate fulfilment, stale fulfilment and wrong request identity.
- Test round settlement under concurrent transactions and delayed cranks.

## Token gates

- Confirm decimals and metadata.
- Confirm Token Program versus Token-2022. Do not add a transfer-fee extension while wallet
  transfers are promised to be untaxed.
- Mint exactly 100 MYNE to the documented launch-liquidity destination.
- Set the mint authority to the program PDA if mining emissions continue on-chain.
- Revoke freeze authority at mint creation. MYNE must launch with no freeze authority; only the
  protocol config PDA retains mint authority for capped mining emissions.
- Enforce the 2,000,000 MYNE hard cap in the program before granting mint authority.

## Operational gates

- Use exactly three distinct controlled funded roles: admin/upgrade/direct-fee/fallback,
  Switchboard/randomness/lifecycle, and buyback. Do not alias their addresses. Keep the admin key
  hardware-backed/offline except for reviewed operations. A multisig is not part of the chosen
  operating model; that makes backups, access logging and tested key rotation mandatory.
- Keep deployment keys out of the repository and frontend environment files.
- Fund and rehearse devnet deployment from a dedicated deployer.
- Publish program ID, mint, IDL hash, build provenance and authority addresses.
- Apply and verify every versioned production Supabase migration in order, and retain indexed `RoundFeesDistributed`
  evidence before any round is archived.
- Commission an independent security audit and resolve findings.
- Run a public devnet period with capped funds and an incident-response plan.
- Only then consider mainnet; revoke or timelock upgrade authority according to the published policy.

## Legal/product review

Mining includes paid entry, chance and prize mechanics. Obtain jurisdiction-specific legal
advice before public deployment. This repository does not make a legal classification.
