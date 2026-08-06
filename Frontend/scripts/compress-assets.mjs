import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants } from 'node:zlib';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
// URL.pathname leaves spaces and other characters percent-encoded, which makes
// perfectly valid project paths (for example, "Project name TBC") unreadable.
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const COMPRESSIBLE = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt', '.xml']);
const MIN_BYTES = 1024;

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }));
  return nested.flat();
}

let sourceBytes = 0;
let compressedBytes = 0;
let count = 0;

for (const path of await filesUnder(ROOT)) {
  if (!COMPRESSIBLE.has(extname(path))) continue;
  const source = await readFile(path);
  if (source.byteLength < MIN_BYTES) continue;

  const [gzipped, brotlied] = await Promise.all([
    gzipAsync(source, { level: 9 }),
    brotliAsync(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      },
    }),
  ]);

  await Promise.all([
    writeFile(`${path}.gz`, gzipped),
    writeFile(`${path}.br`, brotlied),
  ]);
  sourceBytes += source.byteLength;
  compressedBytes += brotlied.byteLength;
  count += 1;
}

const percent = sourceBytes ? Math.round((1 - compressedBytes / sourceBytes) * 100) : 0;
console.log(`precompressed ${count} assets with Brotli/Gzip (${percent}% smaller over Brotli)`);
