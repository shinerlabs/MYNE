---
name: solana-dev
description: Build, change, debug, test, or review Solana applications, including Anchor and Pinocchio programs, Rust crates, TypeScript clients, PDAs, CPIs, tokens, transaction construction, compute optimization, and deployment safety. Use for Solana program or dApp work and for security reviews of Solana code.
---

# Solana Development

Work from the repository's existing versions, conventions, and toolchain. Inspect `Anchor.toml`, `Cargo.toml`, `package.json`, lockfiles, and tests before selecting APIs or commands. Use the bundled Solana documentation MCP for version-sensitive questions; if it is unavailable, consult current official documentation instead of guessing.

## Load only the relevant reference

- Anchor programs: read [references/anchor.md](references/anchor.md).
- Pinocchio or zero-copy programs: read [references/pinocchio.md](references/pinocchio.md).
- Any Rust program or crate: read [references/rust.md](references/rust.md).
- TypeScript clients and dApps: read [references/typescript.md](references/typescript.md).
- Token-2022 and token extensions: read [references/token-2022.md](references/token-2022.md), then verify APIs against the installed package versions.
- Deployment and authority planning: read [references/deployment.md](references/deployment.md), verify version-sensitive commands with official documentation, and require explicit confirmation before any mainnet action.
- Security reviews: read [references/security-review.md](references/security-review.md) and the relevant framework reference.

For mixed-stack work, read each applicable reference. Treat repository-specific instructions as higher priority.

## Workflow

1. Inspect the affected program, client, tests, generated types, and configuration.
2. Identify the framework and installed versions. Preserve the existing package family unless the user requested a migration.
3. State the security invariants before changing on-chain logic: authorized signers, owners, PDA seeds and bumps, writable accounts, CPI targets, token mint/authority relationships, arithmetic bounds, and replay or reinitialization protections.
4. Make the smallest coherent change. Keep client account derivation and generated interfaces aligned with the program.
5. Add or update tests for the happy path, authorization failures, invalid accounts, boundary arithmetic, duplicate or reordered accounts where relevant, and the reported regression.
6. Run the repository's actual formatting, build, lint, and test commands. Prefer existing scripts over invented commands.
7. Review the final diff for accidental public API, account-layout, seed, IDL, or deployment changes.

## Non-negotiable safety rules

- Never deploy to mainnet or spend funds without explicit user confirmation.
- Validate every signer, owner, PDA, executable program, and relationship relied on by the instruction.
- Validate CPI target program IDs and reload accounts after CPIs when later logic depends on mutated data.
- Use checked arithmetic and fallible conversions in program logic. Reject zero divisors and invalid ranges.
- Avoid `unwrap()` and `expect()` in production program code.
- Store and reuse canonical PDA bumps when the account model permits it.
- Simulate transactions before sending when the client and RPC flow support simulation.
- Keep secrets, private keys, seed phrases, and API keys out of code, logs, fixtures, and plugin configuration.

## Verification

Use the commands already established by the project. Typical checks, when supported, are:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
anchor build
anchor test
```

Do not claim a check passed unless it ran successfully. If a required CLI, validator, network, keypair, or funded account is missing, report the exact unverified boundary and complete all safe local checks that remain.

Before a deployment request, confirm the target cluster, program ID, upgrade authority, wallet address, expected balance impact, and whether the build is reproducible. Default to devnet or a local validator.
