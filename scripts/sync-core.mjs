import {copyFile} from 'node:fs/promises';
// Chrome deduplicates resources across content script declarations. Both worlds
// therefore use separate URLs, with one maintained source and a verified copy.
await copyFile(new URL('../extension/shared/core.js', import.meta.url), new URL('../extension/shared/core-main.js', import.meta.url));
console.log('Synchronized MAIN-world core resource.');
