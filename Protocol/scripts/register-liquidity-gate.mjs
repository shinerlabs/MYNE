import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import anchor from '@anchor-lang/core';
import web3 from '@solana/web3.js';

const { AnchorProvider, BN, Program, setProvider } = anchor;
const { PublicKey } = web3;
const PROGRAM_ID = new PublicKey('D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e');
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const idl = JSON.parse(await readFile(new URL('../target/idl/myne_protocol.json', import.meta.url), 'utf8'));
const provider = AnchorProvider.env();
setProvider(provider);
assert.equal(await provider.connection.getGenesisHash(), DEVNET_GENESIS_HASH, 'RPC is not Solana devnet');
assert.ok(process.env.METEORA_POOL, 'Set METEORA_POOL to the official Meteora pool address');
assert.ok(process.env.METEORA_POOL_PROGRAM, 'Set METEORA_POOL_PROGRAM to the official Meteora program ID');
assert.ok(process.env.METEORA_MYNE_VAULT, 'Set METEORA_MYNE_VAULT to the MYNE vault in the Meteora pool');
assert.ok(process.env.METEORA_SOL_VAULT, 'Set METEORA_SOL_VAULT to the WSOL vault in the Meteora pool');
const pool = new PublicKey(process.env.METEORA_POOL);
const poolProgram = new PublicKey(process.env.METEORA_POOL_PROGRAM);
assert.equal(poolProgram.toBase58(), 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Pool program must be Meteora DLMM');
const myneVault = new PublicKey(process.env.METEORA_MYNE_VAULT);
const solVault = new PublicKey(process.env.METEORA_SOL_VAULT);
const minSol = BigInt(process.env.MIN_LIQUIDITY_SOL_LAMPORTS ?? '100000000');
const minMyne = BigInt(process.env.MIN_LIQUIDITY_MYNE_BASE_UNITS ?? '10000000000');
assert.ok(minSol > 0n && minMyne > 0n, 'Liquidity thresholds must be positive');
const poolInfo = await provider.connection.getAccountInfo(pool, 'confirmed');
assert.ok(poolInfo?.data.length, 'Configured pool account does not exist');
assert.ok(poolInfo.owner.equals(poolProgram), 'Pool is not owned by the configured Meteora program');

const program = new Program(idl, provider);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
const [liquidityGate] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_gate')], PROGRAM_ID);
const configState = await program.account.protocolConfig.fetch(config);
assert.ok(configState.admin.equals(provider.wallet.publicKey), 'Wallet is not protocol admin');
assert.equal(await provider.connection.getAccountInfo(liquidityGate, 'confirmed'), null, 'Liquidity gate is already initialized');

const signature = await program.methods
  .initializeLiquidityGate(pool, poolProgram, new BN(minSol.toString()), new BN(minMyne.toString()))
  .accounts({
    config,
    liquidityGate,
    pool,
    baseVault: myneVault,
    quoteVault: solVault,
    admin: provider.wallet.publicKey,
    systemProgram: web3.SystemProgram.programId,
  })
  .rpc();

console.log(JSON.stringify({
  ok: true,
  liquidityGate: liquidityGate.toBase58(),
  pool: pool.toBase58(),
  poolProgram: poolProgram.toBase58(),
  minSolLamports: minSol.toString(),
  minMyneBaseUnits: minMyne.toString(),
  signature,
  next: 'call set_paused(false) only after independently verifying pool reserves',
}, null, 2));
