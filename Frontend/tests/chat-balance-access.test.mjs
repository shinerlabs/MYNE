import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [main, social, roundsIndex, chatSend] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/social/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/chain/rounds-index.js', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/functions/chat-send/index.ts', import.meta.url), 'utf8'),
]);

test('the browser does not retain the obsolete five-mined-round chat gate', () => {
  assert.doesNotMatch(main, /chatRequiresMinedRounds|getMinedRoundCount|countMyBetRounds/);
  assert.doesNotMatch(social, /chatRequiresMinedRounds|getMinedRoundCount|Mine .* more round/);
  assert.doesNotMatch(roundsIndex, /countMyBetRounds/);
  assert.match(social, /setChatComposeEnabled\(Boolean\(account\)\)/);
});

test('the server remains authoritative for the 0.01 MYNE threshold', () => {
  assert.match(chatSend, /readMyneChatBalance\(session\.walletAddress\)/);
  assert.match(chatSend, /Hold at least 0\.01 MYNE/);
});
