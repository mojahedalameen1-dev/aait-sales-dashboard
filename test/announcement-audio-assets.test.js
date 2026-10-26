import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAnnouncementAssetLoader, parseAnnouncementAssetManifest } from '../src/announcement-audio-assets.js';
import { createAnnouncementAudioCache } from '../src/announcement-audio-cache.js';
import { writeStaticAudioManifest } from '../scripts/warm-call-audio.js';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

function wavFixture() {
    const bytes = Buffer.alloc(52);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24000, 24);
    bytes.writeUInt32LE(48000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(8, 40);
    return bytes;
}

function manifest(keys) {
    return new Response(JSON.stringify({ version: 1, keys }), { headers: { 'Content-Type': 'application/json' } });
}

test('asset manifests accept SHA keys only, never paths or external URLs', () => {
    assert.deepEqual([...parseAnnouncementAssetManifest({ version: 1, keys: [KEY, KEY] })], [KEY]);
    for (const payload of [null, [], { version: 2, keys: [KEY] }, { version: 1, keys: ['https://other.test/audio.wav'] }, { version: 1, keys: ['../audio.wav'] }, { version: 1, keys: [KEY.toUpperCase()] }, { version: 1, keys: Array(10001).fill(KEY) }]) {
        assert.equal(parseAnnouncementAssetManifest(payload), null);
    }
});

test('unprepared office assets never issue speculative WAV requests and share one manifest fetch', async () => {
    const requests = [];
    const load = createAnnouncementAssetLoader({ fetcher: async (url, options) => { requests.push({ url, options }); return manifest([]); } });
    assert.equal(await load('../unsafe'), null);
    assert.equal(requests.length, 0);
    assert.deepEqual(await Promise.all([load(KEY), load(OTHER_KEY)]), [null, null]);
    assert.deepEqual(requests, [{ url: '/audio/calls/manifest.json', options: { cache: 'no-cache' } }]);
});

test('only indexed assets use the immutable same-origin WAV path', async () => {
    const requests = [];
    const load = createAnnouncementAssetLoader({ fetcher: async (url, options) => {
        requests.push({ url, options });
        return url.endsWith('.json') ? manifest([KEY]) : new Response(wavFixture(), { headers: { 'Content-Type': 'audio/wav' } });
    } });
    assert.equal((await load(KEY)).size, 52);
    assert.equal(await load(OTHER_KEY), null);
    assert.deepEqual(requests.map(item => item.url), ['/audio/calls/manifest.json', `/audio/calls/${KEY}.wav`]);
    assert.equal(requests[1].options.cache, 'force-cache');
});

test('missing, malformed, oversized or failed manifest responses safely skip optional WAVs', async () => {
    const sources = [
        () => new Response('not found', { status: 404 }),
        () => new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
        () => new Response('{bad json', { headers: { 'Content-Type': 'application/json' } }),
        () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
        () => manifest(['https://other.test/audio.wav']),
        () => { throw new Error('offline'); }
    ];
    for (const source of sources) {
        let requests = 0;
        const load = createAnnouncementAssetLoader({ fetcher: async () => { requests++; return source(); } });
        assert.equal(await load(KEY), null);
        assert.equal(await load(KEY), null);
        assert.equal(requests, 1);
    }
});

test('an unavailable indexed WAV returns null for the existing Groq fallback', async () => {
    for (const response of [() => new Response('missing', { status: 404 }), () => new Response('html', { headers: { 'Content-Type': 'text/html' } }), () => { throw new Error('offline'); }]) {
        const load = createAnnouncementAssetLoader({ fetcher: async url => url.endsWith('.json') ? manifest([KEY]) : response() });
        assert.equal(await load(KEY), null);
    }
});

test('an unindexed asset falls back once, then persistent cache reuse avoids both provider and asset work', async () => {
    const entries = new Map();
    const store = { get: async key => entries.get(key), put: async (key, blob) => entries.set(key, blob) };
    let manifestRequests = 0;
    let providerRequests = 0;
    const load = createAnnouncementAssetLoader({ fetcher: async () => { manifestRequests++; return manifest([]); } });
    const options = { cacheKey: KEY, callType: 'office', loadAsset: () => load(KEY), loadGenerated: async () => { providerRequests++; return new Blob([wavFixture()], { type: 'audio/wav' }); } };
    assert.equal((await createAnnouncementAudioCache({ store, locks: null }).getOrCreate(options)).source, 'groq');
    assert.equal((await createAnnouncementAudioCache({ store, locks: null }).getOrCreate(options)).source, 'indexeddb');
    assert.equal(manifestRequests, 1);
    assert.equal(providerRequests, 1);
});

test('the static generator indexes all validated WAV versions without deleting or modifying existing assets', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aait-static-audio-index-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = wavFixture();
    await writeFile(join(directory, `${KEY}.wav`), original);
    await writeFile(join(directory, `${'c'.repeat(64)}.wav`), 'invalid audio');
    await writeFile(join(directory, 'untrusted-name.wav'), original);
    assert.deepEqual(await writeStaticAudioManifest(directory), [KEY]);
    await writeFile(join(directory, `${OTHER_KEY}.wav`), original);
    assert.deepEqual(await writeStaticAudioManifest(directory), [KEY, OTHER_KEY]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), { version: 1, keys: [KEY, OTHER_KEY] });
    assert.deepEqual(await readFile(join(directory, `${KEY}.wav`)), original);
    assert.equal(await readFile(join(directory, `${'c'.repeat(64)}.wav`), 'utf8'), 'invalid audio');
    assert.equal((await readdir(directory)).some(name => name.startsWith('.manifest-')), false);
});

test('the generator dry run does not update the manifest or use any service key', async () => {
    const manifestPath = new URL('../public/audio/calls/manifest.json', import.meta.url);
    const before = await readFile(manifestPath, 'utf8');
    const beforeStat = await stat(manifestPath);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/warm-call-audio.js', import.meta.url)), '--dry-run'], {
        encoding: 'utf8', env: { ...process.env, GROQ_API_KEY: 'must-not-be-used-during-dry-run', GROQ_VOICE: 'fahad' }
    });
    assert.equal(child.status, 0);
    assert.equal(JSON.parse(child.stdout.trim()).dryRun, true);
    assert.equal(child.stdout.includes('must-not-be-used'), false);
    assert.equal(await readFile(manifestPath, 'utf8'), before);
    assert.equal((await stat(manifestPath)).mtimeMs, beforeStat.mtimeMs);
});
