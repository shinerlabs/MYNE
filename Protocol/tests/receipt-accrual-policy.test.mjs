import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../programs/myne_protocol/src/lib.rs', import.meta.url),
  'utf8',
);

const instructionBody = (name, next) => source.slice(
  source.indexOf(`pub fn ${name}`),
  source.indexOf(`pub fn ${next}`),
);

test('all receipt processors accrue SOL instead of paying a beneficiary', () => {
  for (const [name, next] of [
    ['claim_receipt', 'claim_auto_burn_receipt'],
    ['claim_auto_burn_receipt', 'settle_receipt'],
    ['settle_receipt', 'refund_receipt'],
  ]) {
    const body = instructionBody(name, next);
    assert.match(body, /accrue_receipt_sol\(/, `${name} must use the canonical accrual helper`);
    assert.match(body, /emit!\(ReceiptRewardAccruedV1/);
    assert.doesNotMatch(body, /move_lamports\([\s\S]*accounts\.(?:authority|beneficiary)/);
  }
});

test('the accrual helper moves Round to StakePool without touching the staking index', () => {
  const helper = source.slice(
    source.indexOf('fn accrue_receipt_sol'),
    source.indexOf('/// Value a miner'),
  );
  assert.match(helper, /move_lamports\([\s\S]*round\.to_account_info\(\)[\s\S]*stake_pool\.to_account_info\(\)/);
  assert.match(helper, /stake_position\.pending_sol = next_pending/);
  assert.match(helper, /stake_pool\.total_funded_lamports = next_funded/);
  assert.match(helper, /round\.claimed_lamports = next_round_claimed/);
  assert.doesNotMatch(helper, /fund_stake_rewards\(/);
});

test('principal refunds remain direct and round cleanup invariants remain enforced', () => {
  const refund = instructionBody('refund_receipt', 'refund_receipt_permissionless');
  const permissionlessRefund = instructionBody('refund_receipt_permissionless', 'archive_round');
  assert.match(refund, /move_lamports\([\s\S]*accounts\.authority/);
  assert.match(permissionlessRefund, /move_lamports\([\s\S]*accounts\.beneficiary/);
  assert.match(source, /round\.processed_receipts == ctx\.accounts\.round\.total_receipts/);
  assert.match(source, /round\.closed_receipts == ctx\.accounts\.round\.total_receipts/);
});

test('the versioned event coexists with historical direct-payment decoding', () => {
  assert.match(source, /pub struct ReceiptClaimed/);
  assert.match(source, /pub struct ReceiptRewardAccruedV1/);
  assert.match(source, /pub claim_vault: Pubkey/);
  assert.match(source, /pub pending_sol_after: u64/);
});
