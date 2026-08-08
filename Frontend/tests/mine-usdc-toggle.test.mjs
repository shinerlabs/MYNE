import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const surfaces = await readFile(new URL('../src/surface-system.css', import.meta.url), 'utf8');
const icon = await readFile(new URL('../public/usdc.png', import.meta.url));

test('Mine presents USDC as a quote with one fixed input mark and a text-only switch', () => {
  assert.match(source, />USDC<\/span>/);
  assert.match(source, /USDC \/ tile/);
  assert.match(source, /usdcValueFor/);
  assert.match(source, /getSolUsdc/);
  assert.match(source, /src="\/usdc\.png"/);
  assert.match(surfaces, /url\('\/usdc\.png'\)/);
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(surfaces, /\.slot \.mine-currency-value\[data-usd\]::after[\s\S]*background: none/);
  assert.doesNotMatch(source, /usdcIcon\('toggle-usdc'\)/);
  assert.match(source, /usdcIcon\('amount-usd-mark mine-usdc-mark'\)/);
  assert.doesNotMatch(source, /quick-usdc/);
  assert.match(surfaces, /\.mine-currency-toggle \.toggle-usdc[\s\S]*display: none !important/);
  assert.match(surfaces, /\.amount-display \.amount-usd-mark[\s\S]*display: none !important/);
  assert.match(surfaces, /mine-display-usd[^\n]*\.deploy-panel > \.amount-display \.amount-usd-mark[\s\S]*display: block !important/);
  assert.match(surfaces, /\.mine-currency-toggle:not\(\.active\) > span[\s\S]*color: #fff !important/);
});

test('Mine summary currency rows render one centered icon and value group', () => {
  assert.match(surfaces, /\.deployed-token-value::after[\s\S]*content: none !important/);
  assert.match(surfaces, /\.deployed-usd-value > span[\s\S]*font-size: inherit !important/);
  assert.match(surfaces, /\.motherlode-eth-usd > \.motherlode-usdc-value[\s\S]*font-size: inherit !important/);
  assert.match(surfaces, /mine-display-usd[^\n]*\.deployed-stat > \.deployed-usd-value[\s\S]*display: flex !important/);
  assert.match(surfaces, /mine-display-usd[^\n]*\.deployed-stat > \.deployed-token-value\.deployed-token-value\.deployed-token-value[\s\S]*display: none !important/);
  assert.match(surfaces, /mine-display-usd[^\n]*\.motherlode-secondary > \.motherlode-eth-usd[\s\S]*display: inline-flex !important/);
  assert.match(surfaces, /deployed-stat :is\(\.summary-eth, \.summary-usdc\)[\s\S]*width: 19px !important/);
  assert.match(source, /deployedQuote = selectedUsd \? deployedHeading\.dataset\.solLabel : deployedHeading\.dataset\.usdLabel/);
  assert.match(source, /deployedHeading\.textContent = 'DEPLOYED'/);
  assert.match(source, /deployedHeading\.dataset\.hoverLabel = deployedQuote/);
  assert.match(source, /deployedTokenLabel\.hidden = true/);
  assert.match(surfaces, /\.deployed-stat > \.deployed-token-label[\s\S]*display: none !important/);
  assert.match(surfaces, /:is\(\.deployed-stat, \.motherlode-stat\):is\(:hover, :focus-visible\) > span::after[\s\S]*content: attr\(data-hover-label\) !important/);
  assert.match(surfaces, /:is\(\.deployed-stat, \.motherlode-stat\):is\(:hover, :focus-visible\) > span[\s\S]*font-size: var\(--mine-summary-label-size, 9px\) !important/);
});

test('desktop Mine summary uses the enlarged reference proportions', async () => {
  const viewport = await readFile(new URL('../src/viewport-fit.css', import.meta.url), 'utf8');
  assert.match(viewport, /--mine-summary-value-size: clamp\(34px, 2\.7vw, 42px\)/);
  assert.match(viewport, /--mine-summary-label-size: clamp\(11px, \.95vw, 13px\)/);
  assert.match(viewport, /--mine-summary-icon-size: clamp\(26px, 2\.1vw, 31px\)/);
  assert.match(viewport, /\.motherlode-secondary[\s\S]*font-size: var\(--mine-summary-value-size\) !important/);
});

test('Total deployment swaps denomination without pseudo hover conversion or geometry changes', () => {
  assert.match(source, /class="mine-total-value"/);
  assert.match(source, /const paintMineTotal = \(row, solAmount\)/);
  assert.match(source, /unit\.textContent = usd \? 'USDC' : 'SOL'/);
  assert.doesNotMatch(source, /setMineUsdValue\(document\.querySelector\('#total-amount'/);
  assert.match(surfaces, /\.mine-total-mark[\s\S]*width: 13px[\s\S]*height: 13px/);
  assert.match(surfaces, /mine-display-usd[^\n]*\.mine-total-mark > \.mine-usdc-mark[\s\S]*display: block !important/);
});

test('USDC mode remains presentation-only while SOL stays canonical', () => {
  assert.match(source, /let amountSolValue/);
  assert.match(source, /const price = getSolUsdc\(\)/);
  assert.match(source, /amountSolValue = shown \/ price/);
  assert.match(source, /const entered = amountSolValue/);
  assert.match(source, /Transactions settle on Solana/);
});

test('the small first-bet account deposit is never rounded down to 0.00 SOL', () => {
  assert.match(source, /const mineAccountDepositLabel = \(\) => mineDisplayCurrency === 'usd'/);
  assert.match(source, /ACCOUNT_DEPOSIT_ETH\.toFixed\(4\)/);
  assert.match(source, /first bet adds a one-time \$\{mineAccountDepositLabel\(\)\} account deposit/);
});
