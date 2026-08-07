import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PUBLIC = new URL('../public/', import.meta.url);
const WEBSITE = 'https://www.myne.supply';
const X_ACCOUNT = 'https://x.com/myne_solana';
const PNG_URL = `${WEBSITE}/myne-token-icon-1024.png`;
const SVG_URL = `${WEBSITE}/myne-token-icon.svg`;

test('published MYNE metadata fixes the launch identity and official links', async () => {
  const metadata = JSON.parse(await readFile(new URL('token-metadata.json', PUBLIC), 'utf8'));

  assert.equal(metadata.name, 'MYNE');
  assert.equal(metadata.symbol, 'MYNE');
  assert.equal(metadata.image, PNG_URL);
  assert.equal(metadata.external_url, WEBSITE);
  assert.deepEqual(metadata.properties.files, [
    { uri: PNG_URL, type: 'image/png' },
    { uri: SVG_URL, type: 'image/svg+xml' },
  ]);
  assert.deepEqual(metadata.properties.links, { website: WEBSITE, x: X_ACCOUNT });
  assert.deepEqual(metadata.extensions, { website: WEBSITE, twitter: X_ACCOUNT });
});

test('wallet image is a 1024px PNG derived from the checked-in vector source', async () => {
  const [png, svg] = await Promise.all([
    readFile(new URL('myne-token-icon-1024.png', PUBLIC)),
    readFile(new URL('myne-token-icon.svg', PUBLIC), 'utf8'),
  ]);

  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.match(svg, /^<svg\b/);
  assert.doesNotMatch(svg, /<image\b|data:image\//);
});
