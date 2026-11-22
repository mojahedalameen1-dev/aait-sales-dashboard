import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../cloudflare/_headers', import.meta.url);
const destination = new URL('../dist/_headers', import.meta.url);
await copyFile(fileURLToPath(source), fileURLToPath(destination));
console.info('Cloudflare static security/cache headers copied to dist.');
