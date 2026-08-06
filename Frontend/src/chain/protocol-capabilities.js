export const FEATURE_REQUIREMENTS = Object.freeze({
  configuration: ['initialize_protocol', 'initialize_liquidity_gate', 'set_paused', 'propose_admin', 'accept_admin', 'set_randomness_authority'],
  mining: ['open_round', 'bind_round_randomness', 'register_miner', 'deploy', 'settle_round_verified', 'claim_receipt', 'refund_receipt', 'claim_myne'],
  staking: ['stake_standard', 'burn_stake', 'request_unstake', 'withdraw_unstaked', 'claim_staking_rewards', 'fund_staking_rewards'],
  referrals: ['register_miner', 'claim_myne'],
  autoRound: ['create_auto_plan', 'configure_auto_plan', 'fund_auto_plan', 'cancel_auto_plan', 'execute_auto_plan', 'claim_auto_burn_receipt'],
  // Trading is deliberately external to MYNE. This remains unavailable until a concrete Meteora
  // pool address is configured; wallet-to-wallet transfers must never inherit the pool fee.
  swaps: ['__meteora_pool_configured__'],
});

export function capabilitiesFromIdl(idl) {
  const available = new Set((idl?.instructions ?? []).map((instruction) => instruction.name));
  return Object.fromEntries(Object.entries(FEATURE_REQUIREMENTS).map(([feature, required]) => {
    const missing = required.filter((instruction) => !available.has(instruction));
    return [feature, Object.freeze({ ready: missing.length === 0, missing })];
  }));
}
