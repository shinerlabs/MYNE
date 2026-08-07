# Mainnet launch runbook

This is an ordered, controlled launch procedure—not an automatic deployment script. Stop on any mismatch. The read-only artifact preflight is:

```bash
./scripts/check-mainnet-readiness.sh
```

Mainnet must initialize fresh version-5 state. The existing version-3 Devnet state is not a Mainnet migration source.

## 1. Prepare exactly three funded roles

1. **Admin role:** deployer, upgrade authority, protocol admin, fallback referral-fee owner and reserved Motherlode layout address. Keep this key hardware-backed/offline except for reviewed administration.
2. **Randomness role:** Switchboard authority, round rent payer, archive attestor, indexer and lifecycle keeper.
3. **Buyback role:** receives only the 2% allocations, performs the registered-pool swaps and burns, and marks completion.

Use separate service credentials for Supabase/RPC. They are not funded Solana roles and must never enter the repository.

## 2. Freeze and independently review the artifact

Run all checks, record the Git commit and SBF hash, then stop rebuilding. Give the exact source and artifact to an unaffiliated Solana reviewer using `INDEPENDENT_SECURITY_REVIEW_SCOPE.md`. Resolve every critical/high finding and repeat the full suite after any change.

## 3. Deploy while inactive

Deploy the recorded `.so` to the fixed program ID. Verify ProgramData, executable owner and upgrade authority. Create a 9-decimal mint with exactly 100 MYNE, no freeze authority and the config PDA as mint authority. Initialize paused with Switchboard Mainnet and the three reviewed role addresses.

Run `pnpm prepare:admin-ata` with the explicit confirmation value after the mint/config exist. Verify that this creates exactly the canonical MYNE associated token account owned by the admin fallback role.

## 4. Start the production index before protocol activity

Apply `supabase/migrations/20260807090000_round_index.sql`. Run the event indexer from a recorded start slot with finalized reads and service-role credentials. Run the lifecycle keeper with the same randomness role. Set:

```text
ROUND_INDEXER_REQUIRE_BUYBACK_EVIDENCE=1
RANDOMNESS_RETENTION_SECONDS=86400
```

Supervise both processes with durable logs, restart policy and alerts. Confirm no production `getProgramAccounts` scan is made.

Switchboard also creates an auxiliary lookup table for each randomness request. `closeIx()` closes
the randomness account after the verification window, but later LUT rent recovery requires the
ephemeral request signer after Solana's lookup-table cooldown. Retain those ephemeral signers only
in the production secret manager and add the audited post-cooldown `closeLutIx()` operation; never
write their private keys to the repository or an ordinary keeper journal.

## 5. Create and register the official Meteora pool

Create the MYNE/WSOL DLMM pool. Independently verify the Meteora program owner, pool address, both reserve PDAs, mint order and reserve thresholds. Register that exact gate while paused. The gate is immutable for this initialization and is checked again at every settlement.

## 6. Rehearse randomness and buyback while paused/controlled

Run the exact Switchboard create/commit/open/bind/reveal/settle flow with measured compute. Confirm wrong owner/binding, stale reveal, duplicate settlement and missed-reveal paths fail safely. Run the buyback keeper in dry-run mode, then authorize one tiny direct-pool canary. Verify swap and burn signatures appear in `mine_buyback_executions`.

## 7. Activate once and observe one complete round

Only after all gates pass, submit `set_paused(false)` with the exact pool and reserve accounts. Save the config snapshot and activation signature. Observe one complete low-volume round through:

1. receipt creation;
2. Switchboard settlement;
3. permissionless accumulated and auto-burn reward processing;
4. 2% swap/burn and indexed evidence;
5. deterministic archive commitment;
6. receipt closure with rent returned to users;
7. round closure with rent returned to the randomness role;
8. delayed Switchboard randomness closure.

If any counter, payout invariant, archive hash or evidence total disagrees, pause and investigate. Do not advertise until this sequence and the independent review are signed off.
