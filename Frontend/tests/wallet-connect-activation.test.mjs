import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readableError } from '../src/chain/client.js';

test('wallet chooser starts connect inside the trusted wallet-row click', async () => {
  const [main, minePage] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/chain/mine-page.js', import.meta.url), 'utf8'),
  ]);
  const pickerStart = main.indexOf('const walletPicker =');
  const pickerEnd = main.indexOf('chain.setWalletChooser(walletPicker)', pickerStart);
  const picker = main.slice(pickerStart, pickerEnd);
  const installedClick = picker.indexOf("row.addEventListener('click', () => {");
  const connectCall = picker.indexOf('connectSelected(wallet.rdns)', installedClick);
  const dialogClose = picker.indexOf('dlg.close()', installedClick);

  assert.match(picker, /walletPicker = \(wallets, lastRdns, connectSelected\)/);
  assert.ok(connectCall > installedClick, 'selected wallet connect is invoked by the row click');
  assert.ok(dialogClose > connectCall, 'wallet connect starts before the picker closes');
  assert.doesNotMatch(picker, /dlg\.dataset\.pick/);

  const connectStart = minePage.indexOf('export async function connectWallet');
  const connectEnd = minePage.indexOf('export function disconnectWallet', connectStart);
  const connectFlow = minePage.slice(connectStart, connectEnd);
  assert.match(connectFlow, /walletChooser\(wallets, getLastWalletRdns\(\), connect\)/);
  assert.doesNotMatch(connectFlow, /await connect\(chosen\)/);
});

test('wallet popup failures are readable even when an adapter wraps the cause', () => {
  assert.equal(
    readableError(new Error('Owl extension-created tab was blocked before presentation')),
    'This embedded browser blocked wallet approval — open myne.supply in Chrome, Brave, or your wallet browser',
  );
  assert.equal(
    readableError(new Error('Wallet adapter failed', { cause: new Error('Unable to open popup window') })),
    'Wallet popup was blocked — click Connect and choose your wallet again',
  );
  assert.equal(readableError(new Error('User rejected request')), 'Transaction rejected');
});

test('paused-program errors explain the claim-safe maintenance boundary', () => {
  assert.equal(
    readableError(new Error('Transaction simulation failed: custom program error: 0x177c')),
    'Mining is paused for maintenance. Your rewards remain recorded; Claim SOL is available, while MYNE claim and burn require the claim-safe program release.',
  );
});
