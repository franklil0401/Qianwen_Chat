import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'desktop-dist');
// Only this known generated directory may be removed; reject altered targets.
if (dirname(resolve(output)) !== resolve(root) || basename(output) !== 'desktop-dist') throw new Error('Unexpected desktop build output path');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'server'), { recursive: true });
const common = { platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: [join(root, 'desktop/main.ts')], outfile: join(output, 'main.mjs') });
await build({ ...common, entryPoints: [join(root, 'server/app.ts')], outfile: join(output, 'server/app.mjs') });
await cp(join(root, 'server/document-worker.mjs'), join(output, 'server/document-worker.mjs'));
await cp(join(root, 'data'), join(output, 'data'), { recursive: true });

// Reuse the product's vector mark. ICO entries contain PNG images at each size.
const icon = await loadImage(await readFile(join(root, 'desktop-assets/icon.svg')));
const sizes = [16, 32, 48, 64, 128, 256];
const pngs = sizes.map(size => { const canvas = createCanvas(size, size); canvas.getContext('2d').drawImage(icon, 0, 0, size, size); return canvas.toBuffer('image/png'); });
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const at = 6 + index * 16;
  header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[index].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += pngs[index].length;
}
await writeFile(join(output, 'icon.ico'), Buffer.concat([header, ...pngs]));
await writeFile(join(output, 'icon.png'), pngs.at(-1));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(output, 'build-info.json'), JSON.stringify({ version: metadata.version, platform: process.platform, arch: process.arch, createdAt: new Date().toISOString() }, null, 2));
console.log(`Desktop files prepared: ${resolve(output)}`);
