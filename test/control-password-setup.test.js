import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('password setup imports only existing module exports without running the interactive setup', async () => {
    const scriptUrl = new URL('../scripts/setup-control-passwords.js', import.meta.url);
    const source = await readFile(scriptUrl, 'utf8');
    const imports = [...source.matchAll(/const\s+\{([^}]+)\}\s*=\s*await\s+import\('([^']+)'\)/g)];
    assert.equal(imports.length, 2);
    for (const [, names, specifier] of imports) {
        const exports = await import(new URL(specifier, scriptUrl));
        for (const name of names.split(',').map(value => value.trim())) {
            assert.ok(Object.hasOwn(exports, name), `${name} must be exported by ${specifier}`);
        }
    }
});
