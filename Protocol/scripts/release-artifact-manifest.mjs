/** Print or verify the immutable identifiers for a frozen Mainnet artifact. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const PROGRAM_ID = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const PRODUCTION_ARTIFACT_MARKER = 'MYNE_PRODUCTION_ARTIFACT_V1';
const REHEARSAL_ARTIFACT_MARKER = 'MYNE_REHEARSAL_ARTIFACT_V1';
const files = Object.freeze({
  sbf: 'target/deploy/myne_protocol.so',
  idl: 'target/idl/myne_protocol.json',
  cargoLock: 'Cargo.lock',
  pnpmLock: 'pnpm-lock.yaml',
});
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const command = (name, args = []) => execFileSync(name, args, { encoding: 'utf8' }).trim();

async function currentManifest() {
  const sbf = await readFile(files.sbf);
  assert.ok(
    sbf.includes(Buffer.from(PRODUCTION_ARTIFACT_MARKER)),
    'SBF lacks the production-only marker; rebuild with pnpm build:mainnet',
  );
  assert.ok(
    !sbf.includes(Buffer.from(REHEARSAL_ARTIFACT_MARKER)),
    'SBF contains the rehearsal marker and is not eligible for Mainnet',
  );
  return {
    schemaVersion: 2,
    buildProfile: 'production',
    productionArtifactMarker: PRODUCTION_ARTIFACT_MARKER,
    programId: PROGRAM_ID,
    gitCommit: command('git', ['rev-parse', 'HEAD']),
    sbfSha256: await sha256(files.sbf),
    sbfBytes: (await stat(files.sbf)).size,
    idlSha256: await sha256(files.idl),
    cargoLockSha256: await sha256(files.cargoLock),
    pnpmLockSha256: await sha256(files.pnpmLock),
    anchorVersion: command('anchor', ['--version']),
    solanaVersion: command('solana', ['--version']),
  };
}

const mode = process.argv[2];
if (mode === '--print') {
  console.log(JSON.stringify(await currentManifest(), null, 2));
} else {
  assert.equal(mode, '--verify', 'Usage: node scripts/release-artifact-manifest.mjs --print | --verify <manifest.json>');
  const manifestPath = process.argv[3];
  assert.ok(manifestPath, 'A frozen external release manifest path is required');
  const repositoryRoot = resolve(command('git', ['rev-parse', '--show-toplevel']));
  const resolvedManifest = resolve(manifestPath);
  assert.ok(
    !resolvedManifest.startsWith(`${repositoryRoot}${sep}`),
    'Store the frozen manifest outside the Git worktree to avoid a self-referential commit hash',
  );
  const expected = JSON.parse(await readFile(resolvedManifest, 'utf8'));
  const actual = await currentManifest();
  assert.deepEqual(actual, expected, 'Frozen release artifact does not match its manifest');
  assert.equal(
    command('git', ['status', '--porcelain', '--untracked-files=all']),
    '',
    'Release verification requires a clean Git worktree',
  );
  assert.equal(actual.anchorVersion, 'anchor-cli 1.0.2', 'Unexpected Anchor CLI in release manifest');
  assert.match(actual.solanaVersion, /^solana-cli 3\.1\.10(?:\s|$)/, 'Unexpected Solana CLI in release manifest');
  console.log(JSON.stringify({ ok: true, ...actual }, null, 2));
}
