import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSheets, normalizeArabic } from '../api/meetings.js';

test('published sheet index parser discovers tab names and gids', () => {
    const html = 'items.push({name: "يوليو 2026", pageUrl: "x&gid=1", gid: "1446268678"});' +
        'items.push({name: "اغسطس 2026", pageUrl: "x&gid=2", gid: "474705831"});';
    assert.deepEqual(extractSheets(html), [
        { name: 'يوليو 2026', gid: '1446268678' },
        { name: 'اغسطس 2026', gid: '474705831' }
    ]);
});

test('Arabic tab name matching tolerates hamza variants', () => {
    assert.equal(normalizeArabic('أغسطس 2026'), normalizeArabic('اغسطس 2026'));
});
