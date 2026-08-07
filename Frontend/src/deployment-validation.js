import bs58 from 'bs58';

const SUPPORTED_CLUSTERS = new Set(['localnet', 'devnet', 'testnet', 'mainnet-beta']);

const validPublicKeyShape = (value) => {
  if (!value) return true;
  try {
    const text = String(value);
    const bytes = bs58.decode(text);
    return bytes.length === 32 && bs58.encode(bytes) === text;
  } catch { return false; }
};
const isHttps = (value) => {
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
};

/**
 * Validate public deployment identity before the app enables any transaction surface.
 *
 * This intentionally performs no RPC calls. The on-chain config/mint/randomness checks happen in
 * anchor-client.js; these guards stop a malformed or cross-cluster production bundle before that
 * point. VITE values are public, but they still define which program a wallet will be asked to use.
 */
export function validateDeploymentConfig({ network, programs, services = {}, generatedProgramId }) {
  const errors = [];
  const mainnet = network.cluster === 'mainnet-beta';

  if (!SUPPORTED_CLUSTERS.has(network.cluster)) errors.push(`Unsupported Solana cluster: ${network.cluster}`);
  if (!validPublicKeyShape(programs.protocol)) errors.push('MYNE program ID is not a valid Solana address');
  if (!validPublicKeyShape(programs.tokenMint)) errors.push('MYNE mint is not a valid Solana address');
  if (!validPublicKeyShape(programs.randomness)) errors.push('Randomness program is not a valid Solana address');
  if (programs.protocol && generatedProgramId && programs.protocol !== generatedProgramId) {
    errors.push('Configured MYNE program does not match the generated Anchor IDL');
  }
  if (programs.protocol && programs.tokenMint && programs.protocol === programs.tokenMint) {
    errors.push('MYNE program and mint must be different addresses');
  }

  if (mainnet) {
    if (!programs.protocol) errors.push('Mainnet MYNE program ID is not configured');
    if (!programs.tokenMint) errors.push('Mainnet MYNE mint is not configured');
    if (!isHttps(network.rpcUrl)) errors.push('Mainnet RPC must use HTTPS');
    if (/devnet|testnet|localhost|127\.0\.0\.1/i.test(network.rpcUrl)) {
      errors.push('Mainnet frontend is configured with a non-mainnet RPC');
    }
    if (!isHttps(network.explorerUrl)) errors.push('Mainnet explorer must use HTTPS');
    if (!services.indexerUrl) errors.push('Mainnet round indexer is not configured');
    else if (!isHttps(services.indexerUrl)
      || /localhost|127\.0\.0\.1|\.local(?::|\/|$)/i.test(services.indexerUrl)) {
      errors.push('Mainnet round indexer must use a public HTTPS endpoint');
    }
  }

  return errors;
}
