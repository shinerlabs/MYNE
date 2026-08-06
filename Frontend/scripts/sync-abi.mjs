// Copies the deployment export (addresses + ABIs) from the sibling hardhat package into the
// frontend's own `src/deployments`, so the app stays self-contained. Run after a redeploy:
//   npm run sync:abi
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../hardhat/deployments'); // bullion/hardhat/deployments
const dst = path.resolve(here, '../src/deployments');        // bullion/Frontend/src/deployments

// Clear the abi folder first so removed contracts don't leave stale files behind.
fs.rmSync(path.join(dst, 'abi'), { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'abi'), { recursive: true });

// 1. Deployment json (chainId, deployer, genesisTime, contract addresses).
// Copy every deployment present, so switching chains is a config change rather than a re-sync.
// (This used to be hardcoded to 46630 and silently left mainnet out.)
const chains = fs.readdirSync(src).filter((f) => /^\d+\.json$/.test(f));
for (const f of chains) fs.copyFileSync(path.join(src, f), path.join(dst, f));

// 2. All contract ABIs.
const abiSrc = path.join(src, 'abi');
let n = 0;
for (const f of fs.readdirSync(abiSrc)) {
  if (f.endsWith('.json')) {
    fs.copyFileSync(path.join(abiSrc, f), path.join(dst, 'abi', f));
    n++;
  }
}
console.log(`synced ${chains.join(', ')} + ${n} ABIs -> src/deployments`);
