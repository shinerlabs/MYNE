# Security and deployment gates

No MYNE program should reach mainnet until every gate below is satisfied.

## Development gates

- Pin Rust, Solana/Agave, Anchor CLI and Anchor crate versions.
- Generate a unique program keypair; run `anchor keys sync`; verify every declared ID.
- Run unit, integration, property and adversarial tests locally.
- Test checked arithmetic at `u64` boundaries and every basis-point rounding path.
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
- Decide whether a freeze authority exists; disclose it or revoke it.
- Enforce the 2,000,000 MYNE hard cap in the program before granting mint authority.

## Operational gates

- Use a hardware-backed multisig for upgrade and treasury authority.
- Keep deployment keys out of the repository and frontend environment files.
- Fund and rehearse devnet deployment from a dedicated deployer.
- Publish program ID, mint, IDL hash, build provenance and authority addresses.
- Commission an independent security audit and resolve findings.
- Run a public devnet period with capped funds and an incident-response plan.
- Only then consider mainnet; revoke or timelock upgrade authority according to the published policy.

## Legal/product review

Mining includes paid entry, chance and prize mechanics. Obtain jurisdiction-specific legal
advice before public deployment. This repository does not make a legal classification.
