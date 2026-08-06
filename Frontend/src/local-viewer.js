import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_MYNE_PROGRAM_ID || 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e',
);
const [CONFIG_PDA] = PublicKey.findProgramAddressSync([new TextEncoder().encode('config')], PROGRAM_ID);
const connection = new Connection(RPC_URL, 'confirmed');

const byId = (id) => document.getElementById(id);
const set = (id, value) => { byId(id).textContent = value; };
const u64 = (data, offset) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
const i64 = (data, offset) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
const pubkey = (data, offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();

function decodeConfig(data) {
  if (data.length < 299) throw new Error(`Unexpected config size: ${data.length} bytes`);
  return {
    version: data[8],
    paused: data[10] !== 0,
    admin: pubkey(data, 11),
    mint: pubkey(data, 75),
    randomness: pubkey(data, 107),
    initializedAt: i64(data, 235),
    genesis: u64(data, 243),
    max: u64(data, 251),
    minimumLamports: u64(data, 259),
    roundSeconds: u64(data, 267),
    bettingSeconds: u64(data, 275),
    unstakeSeconds: u64(data, 283),
  };
}

function setConnected(connected) {
  byId('pulse').classList.toggle('online', connected);
  byId('pulse').classList.toggle('offline', !connected);
}

async function refresh() {
  set('rpc-status', 'Connecting…');
  setConnected(false);
  try {
    const [slot, programAccount, configAccount] = await Promise.all([
      connection.getSlot('confirmed'),
      connection.getAccountInfo(PROGRAM_ID, 'confirmed'),
      connection.getAccountInfo(CONFIG_PDA, 'confirmed'),
    ]);
    set('rpc-status', 'Connected');
    setConnected(true);
    set('slot', slot.toLocaleString());
    set('updated', `Updated ${new Date().toLocaleTimeString()}`);

    set('program-status', programAccount?.executable ? 'Executable' : 'Missing');
    set('program-owner', programAccount ? `Loader ${programAccount.owner.toBase58()}` : 'Program not deployed');
    set('config-status', configAccount ? 'Initialized' : 'Not initialized');
    set('config-size', configAccount ? `${configAccount.data.length} bytes · rent funded` : 'Run the local protocol test');

    if (!configAccount) return;
    if (!configAccount.owner.equals(PROGRAM_ID)) throw new Error('Config PDA has the wrong owner');
    const config = decodeConfig(configAccount.data);
    set('pause-status', config.paused ? 'Paused safely' : 'Active');
    set('version', config.version);
    set('admin', config.admin);
    set('mint', config.mint);
    set('randomness', config.randomness);
    set('genesis', config.genesis.toLocaleString());
    set('max', config.max.toLocaleString());
    set('minimum', Number(config.minimumLamports) / 1_000_000_000);
    set('round', config.roundSeconds.toString());
    set('betting', config.bettingSeconds.toString());
    set('unstake', (config.unstakeSeconds / 86_400n).toString());
  } catch (error) {
    set('rpc-status', 'Waiting for validator');
    set('program-status', 'Offline');
    set('program-owner', error instanceof Error ? error.message : 'RPC unavailable');
    set('config-status', 'Offline');
    set('config-size', 'Start the local Solana test environment');
    setConnected(false);
  }
}

set('program-id', PROGRAM_ID.toBase58());
set('config-pda', CONFIG_PDA.toBase58());
set('rpc-url', RPC_URL);
byId('refresh').addEventListener('click', refresh);
await refresh();
setInterval(refresh, 5_000);
