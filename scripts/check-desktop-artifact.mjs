import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const filename = `QianwenChat-Setup-${metadata.version}-x64.exe`;
const checksum = createHash('sha256');
for await (const chunk of createReadStream(join('release', filename))) checksum.update(chunk);
const text = `${checksum.digest('hex')}  ${filename}\n`;
const key = process.env.Qianwen_api_key;
if (key) {
  const walk = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  for (const file of await walk('release/win-unpacked/resources')) {
    // The asar archive contains all application sources; unpacked files include
    // parser dependencies. Credentials must appear in neither representation.
    let carry = Buffer.alloc(0);
    const bytes = Buffer.from(key);
    for await (const chunk of createReadStream(file)) {
      const data = Buffer.concat([carry, chunk]);
      if (data.includes(bytes)) throw new Error(`Model credential found in artifact: ${file}`);
      carry = data.subarray(Math.max(0, data.length - bytes.length + 1));
    }
  }
}
await writeFile(join('release', `${filename}.sha256`), text);
console.log(text.trim());
console.log(key ? 'Packaged resources checked; no configured model credential found.' : 'Credential scan skipped: Qianwen_api_key is not set.');
