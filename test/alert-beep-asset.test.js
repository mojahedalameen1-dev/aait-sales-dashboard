import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the approved beep is a valid bundled MP3 and Vercel serves it with an immutable local cache policy', async () => {
    const audio = await readFile(new URL('../public/sounds/beeb.mp3', import.meta.url));
    assert.ok(audio.length > 1000);
    assert.equal(audio.subarray(0, 3).toString('ascii'), 'ID3');

    const id3Size = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14) | ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
    let frameOffset = 10 + id3Size;
    while (frameOffset + 4 < audio.length && (audio[frameOffset] !== 0xff || (audio[frameOffset + 1] & 0xe0) !== 0xe0)) frameOffset++;
    assert.ok(frameOffset + 4 < audio.length, 'MP3 frame sync must exist after the ID3 metadata');
    const header = audio.readUInt32BE(frameOffset);
    assert.equal((header >>> 17) & 0b11, 0b01, 'the file must contain an MPEG Layer III frame');

    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const rule = config.headers.find(item => item.source === '/sounds/beeb.mp3');
    assert.ok(rule);
    assert.equal(rule.headers.find(item => item.key === 'Cache-Control')?.value, 'public, max-age=31536000, immutable');
    assert.equal(rule.headers.some(item => item.key === 'Content-Type'), false, 'the static .mp3 extension uses the platform media MIME type');
});
