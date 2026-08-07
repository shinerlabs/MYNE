# Independent Solana security review scope

The reviewer must be unaffiliated with the implementation and review the exact Git commit plus the recorded SBF hash. At minimum, assess:

- all Anchor account constraints, PDA seeds, owners, signers, close destinations and mutable-account aliasing;
- mint/freeze/upgrade authority and the 2,000,000 MYNE issuance ceiling, including virtual burns and claim-fee redistribution;
- proportional SOL/MYNE allocation, solo/split results, empty-tile rollover, Motherlode sharing and integer rounding;
- Switchboard account layout/owner/authority/commit-slot/reveal-slot validation, censorship and missed-reveal recovery;
- Meteora pool/reserve binding, liquidity thresholds and the direct-route Jupiter buyback/burn keeper;
- permissionless accumulated/auto-burn settlement, refunds, replay prevention and beneficiary immutability;
- receipt/round counters, payout drain invariant, archive attestation, buyback evidence gate and every rent-return path;
- keeper crash recovery, duplicate/reordered transactions, RPC disagreement, database lag/outage and service-role compromise;
- secure retention and post-cooldown destruction of Switchboard ephemeral request signers used to recover auxiliary lookup-table rent;
- compute/account limits under maximum realistic receipt counts, batch sizing and priority-fee bounds;
- migration/fresh-initialization assumptions and all pause/admin incident procedures.

Required deliverables: severity-ranked findings, exploit reproductions where applicable, reviewed commit/artifact identifiers, remediation verification and an explicit list of residual risks. The review is incomplete until critical/high findings are resolved and the full local plus live-cluster failure suite is repeated.
