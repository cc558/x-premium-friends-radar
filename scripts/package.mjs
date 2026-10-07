import {mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = spawnSync(process.execPath, [resolve(root, 'scripts/check.mjs')], {stdio: 'inherit'});
if (check.status !== 0) process.exit(1);
const output = resolve(root, 'dist/x-premium-friends-radar.zip');
await mkdir(resolve(root, 'dist'), {recursive: true});
await rm(output, {force: true});
const result = spawnSync('zip', ['-qr', output, 'extension', 'README.md', 'examples', 'scripts', 'tests', 'package.json'], {cwd: root, stdio: 'inherit'});
if (result.status !== 0) process.exit(1);
console.log(`Created ${output}`);
