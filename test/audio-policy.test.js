import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production CSP allows local cached WAV object URLs without weakening script or connection rules', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const policy = config.headers.find(rule => rule.source === '/(.*)').headers
        .find(header => header.key === 'Content-Security-Policy').value;
    const directives = new Map(policy.split(';').map(part => part.trim().split(/\s+/)).filter(([name]) => name)
        .map(([name, ...sources]) => [name, sources]));
    assert.deepEqual(directives.get('media-src'), ["'self'", 'data:', 'blob:']);
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
    assert.deepEqual(directives.get('form-action'), ["'self'"]);
    assert.ok(!directives.get('connect-src').includes('blob:'));
    assert.ok(!directives.get('connect-src').includes('*'));
});
