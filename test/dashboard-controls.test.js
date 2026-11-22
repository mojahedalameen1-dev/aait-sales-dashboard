import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard toolbar has no manual sound toggle and retains the other controls', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

    assert.doesNotMatch(html, /id="sound-toggle-btn"/);
    assert.doesNotMatch(main, /sound-toggle-btn|toggleSound/);
    assert.match(html, /id="refresh-now-btn"/);
    assert.match(html, /id="theme-toggle-btn"/);
    assert.match(html, /id="settings-toggle-btn"/);
    assert.match(html, /id="display-mode-btn"/);
    assert.match(main, /setAudioStateListener/);
    assert.match(main, /unlockAudio\(\)/);
});
