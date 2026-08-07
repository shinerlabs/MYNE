# Contributing

Changes should be narrowly scoped, include tests for behavior they alter, and preserve the
fail-closed behavior of production deployment, randomness, liquidity, and indexer checks.

Before opening a pull request:

1. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build` in `Frontend/`.
2. Run the relevant Anchor, Rust, keeper, and policy tests for changes under `Protocol/`.
3. Never commit `.env` files, keypairs, credentials, validator ledgers, generated `target/` output,
   or private plugin/tooling bundles.
4. Describe security assumptions, account lifecycle changes, fee/economic changes, migrations, and
   operational rollout requirements explicitly.
5. Record the exact source URL, revision, license or permission, required attribution and local file
   scope for every third-party asset. Do not add media with unknown provenance; update
   [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) with the same change.

Security reports belong in the private channel described in [`SECURITY.md`](SECURITY.md), not in a
public issue.
