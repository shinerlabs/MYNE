import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const EXPECTED_PROGRAM_ID = 'D6kkupmJWw9bpDZ46R8Xn1ncMtC1upopPo2wundvWd3e';
const source = new URL('../../Protocol/target/idl/myne_protocol.json', import.meta.url);
const destination = new URL('../src/generated/myne_protocol.json', import.meta.url);
const idl = JSON.parse(await readFile(source, 'utf8'));

assert.equal(idl.address, EXPECTED_PROGRAM_ID, 'Generated IDL has an unexpected program address');
assert.ok(Array.isArray(idl.instructions) && idl.instructions.length > 0, 'Generated IDL has no instructions');
assert.ok(idl.accounts?.some((account) => account.name === 'ProtocolConfig'), 'IDL is missing ProtocolConfig');

await mkdir(new URL('../src/generated/', import.meta.url), { recursive: true });
await writeFile(destination, `${JSON.stringify(idl, null, 2)}\n`);
console.log(`Synced ${idl.metadata.name} IDL (${idl.instructions.length} instructions)`);
