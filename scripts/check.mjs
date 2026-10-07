import {readFile, readdir, access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = resolve(root, 'extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3');
const isolatedCore = await readFile(resolve(extension, 'shared/core.js'), 'utf8');
const mainCore = await readFile(resolve(extension, 'shared/core-main.js'), 'utf8');
if (isolatedCore !== mainCore) throw new Error('Core copies differ. Run node scripts/sync-core.mjs.');
const scriptWorlds = new Map();
for (const script of manifest.content_scripts) {
  for (const path of script.js) {
    const world = script.world || 'ISOLATED';
    if (scriptWorlds.has(path) && scriptWorlds.get(path) !== world) throw new Error(`Resource reused across execution worlds: ${path}`);
    scriptWorlds.set(path, world);
  }
}
const referenced = [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons || {})];
for (const path of new Set(referenced)) await access(resolve(extension, path));
async function files(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const groups = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return groups.flat();
}
for (const path of (await files(extension)).filter(path => path.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', path], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${path}`);
}
console.log(`Manifest V3 and ${referenced.length} referenced assets checked; all extension JavaScript parses.`);
