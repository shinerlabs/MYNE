# MYNE Mainnet prelaunch status

> **Superseded version-5 record.** This dated artifact record is retained for provenance only. The
> active candidate uses protocol version 6 and the revised 12% fee routing. None of the binary hash,
> byte length or passing-test claims below is evidence for version 6. A clean rebuild, fresh hash,
> synchronized IDLs and repeated full test/security review are required before deployment.

**Recorded:** 2026-08-07
**Public site:** https://www.myne.supply
**Status:** prelaunch; no Mainnet activation was performed by this review.

## Reviewed artifact

- Program ID: `D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e`
- State version: 5 (fresh Mainnet initialization required)
- SBF size: 917,800 bytes
- SBF SHA-256: `6431275770d1ab8e991f97924c2f71d3bc26fc46e4bea26b13f86d4e221019fc`
- Clean SBF build: no empty-syscall-list warning and no stack-overflow warning
- Local validator lifecycle and failure suites: passing

Any source or dependency change invalidates this artifact record and requires a rebuild, new hash and repeated review.

## Devnet finding

The currently deployed program at this ID on Devnet is version 3, is unpaused and reports a non-Switchboard randomness program. It therefore does not exercise the version-5 account lifecycle or keepers. A read-only smoke test correctly fails. Do not upgrade it blindly: version 5 changes singleton/round account layouts. Use a reviewed migration or a fresh version-5 rehearsal state.

## Outstanding gates

- Apply and verify the production Supabase round-index migration.
- Run the indexer, lifecycle keeper and buyback keeper under supervised durable infrastructure.
- Create the final Mainnet mint and pre-create its single admin fallback ATA.
- Create/register the final Meteora pool and complete the tiny buyback/burn canary.
- Complete the exact Switchboard success and failure rehearsal.
- Obtain an independent Solana/Anchor security review and legal review.

The intended Solana wallet model remains three funded roles. No Mainnet program deployment, mint, pool, keeper spend or activation transaction was submitted in this review.
