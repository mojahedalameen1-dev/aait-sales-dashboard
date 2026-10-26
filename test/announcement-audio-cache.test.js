import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAnnouncementAudioCache,
    createIndexedDbAudioStore,
    isValidAnnouncementWav,
    requestPersistentAudioStorage
} from '../src/announcement-audio-cache.js';

const KEY = 'a'.repeat(64);

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
    return new Blob([bytes], { type: 'audio/wav' });
}

function durableStore() {
    const entries = new Map();
    return {
        entries,
        async get(key) { return entries.get(key) || null; },
        async put(key, blob) { entries.set(key, blob); }
    };
}

function serialLocks() {
    const pending = new Map();
    return {
        request(name, _options, callback) {
            const next = (pending.get(name) || Promise.resolve()).catch(() => {}).then(callback);
            pending.set(name, next);
            return next;
        }
    };
}

test('first dynamic request saves one WAV; a fresh cache instance reuses it without the provider', async () => {
    const store = durableStore();
    let providerCalls = 0;
    const loadGenerated = async () => { providerCalls++; return wavFixture(); };
    const firstCache = createAnnouncementAudioCache({ store, locks: null });
    const first = await firstCache.getOrCreate({ cacheKey: KEY, callType: 'meeting', loadGenerated });
    const secondCache = createAnnouncementAudioCache({ store, locks: null });
    const second = await secondCache.getOrCreate({ cacheKey: KEY, callType: 'meeting', loadGenerated });

    assert.equal(first.cache, 'miss');
    assert.equal(first.source, 'groq');
    assert.equal(first.persisted, true);
    assert.equal(second.cache, 'hit');
    assert.equal(second.source, 'indexeddb');
    assert.equal(providerCalls, 1);
    assert.equal(store.entries.size, 1);
    assert.deepEqual(firstCache.getStats(), { hits: 0, misses: 1, providerRequests: 1, storageFailures: 0 });
    assert.deepEqual(secondCache.getStats(), { hits: 1, misses: 0, providerRequests: 0, storageFailures: 0 });
});

test('concurrent identical requests in one instance share a single generation promise', async () => {
    const store = durableStore();
    const cache = createAnnouncementAudioCache({ store, locks: null });
    let providerCalls = 0;
    let finish;
    const generated = new Promise(resolve => { finish = resolve; });
    const options = { cacheKey: KEY, callType: 'meeting', loadGenerated: async () => { providerCalls++; return generated; } };
    const first = cache.getOrCreate(options);
    const second = cache.getOrCreate(options);
    assert.equal(first, second);
    finish(wavFixture());
    await Promise.all([first, second]);
    assert.equal(providerCalls, 1);
});

test('browser-wide lock rechecks IndexedDB so two tabs only generate once', async () => {
    const store = durableStore();
    const locks = serialLocks();
    let providerCalls = 0;
    const options = { cacheKey: KEY, callType: 'meeting', loadGenerated: async () => { providerCalls++; return wavFixture(); } };
    const results = await Promise.all([
        createAnnouncementAudioCache({ store, locks }).getOrCreate(options),
        createAnnouncementAudioCache({ store, locks }).getOrCreate(options)
    ]);
    assert.equal(providerCalls, 1);
    assert.deepEqual(results.map(item => item.cache).sort(), ['hit', 'miss']);
});

test('fixed office asset is used and saved locally without a Groq request', async () => {
    const store = durableStore();
    const cache = createAnnouncementAudioCache({ store, locks: null });
    let providerCalls = 0;
    const result = await cache.getOrCreate({
        cacheKey: KEY,
        callType: 'office',
        loadAsset: async () => wavFixture(),
        loadGenerated: async () => { providerCalls++; return wavFixture(); }
    });
    assert.equal(result.source, 'asset');
    assert.equal(result.cache, 'hit');
    assert.equal(result.persisted, true);
    assert.equal(providerCalls, 0);
    assert.equal(cache.getStats().providerRequests, 0);
});

test('missing or invalid office asset falls back once to generated WAV', async () => {
    const store = durableStore();
    const cache = createAnnouncementAudioCache({ store, locks: null });
    const result = await cache.getOrCreate({
        cacheKey: KEY,
        callType: 'office',
        loadAsset: async () => new Blob(['<!doctype html>'], { type: 'text/html' }),
        loadGenerated: async () => wavFixture()
    });
    assert.equal(result.source, 'groq');
    assert.equal(cache.getStats().providerRequests, 1);
});

test('invalid provider WAV is never saved and a failed callback is not retried by lock fallback', async () => {
    const store = durableStore();
    const cache = createAnnouncementAudioCache({ store, locks: serialLocks() });
    let providerCalls = 0;
    await assert.rejects(cache.getOrCreate({
        cacheKey: KEY,
        callType: 'meeting',
        loadGenerated: async () => { providerCalls++; return new Blob(['not WAV']); }
    }), error => error.code === 'invalid_audio');
    assert.equal(store.entries.size, 0);
    assert.equal(providerCalls, 1);
});

test('invalid cached audio is ignored, not deleted, and replaced by a validated WAV', async () => {
    const store = durableStore();
    store.entries.set(KEY, new Blob(['corrupt']));
    const result = await createAnnouncementAudioCache({ store, locks: null }).getOrCreate({
        cacheKey: KEY, callType: 'meeting', loadGenerated: async () => wavFixture()
    });
    assert.equal(result.cache, 'miss');
    assert.equal(await isValidAnnouncementWav(store.entries.get(KEY)), true);
});

test('unavailable IndexedDB or quota errors do not prevent valid audio playback', async () => {
    const store = { async get() { throw new Error('blocked'); }, async put() { throw new Error('quota'); } };
    const result = await createAnnouncementAudioCache({ store, locks: null }).getOrCreate({
        cacheKey: KEY, callType: 'meeting', loadGenerated: async () => wavFixture()
    });
    assert.equal(result.persisted, false);
    assert.equal(result.warning, 'local_cache_unavailable');
    assert.equal(await isValidAnnouncementWav(result.blob), true);
});

test('unsupported Lock API falls back once, while an invalid key never calls the provider', async () => {
    let providerCalls = 0;
    const cache = createAnnouncementAudioCache({
        store: durableStore(),
        locks: { request() { throw new Error('disabled'); } }
    });
    const loadGenerated = async () => { providerCalls++; return wavFixture(); };
    await assert.rejects(cache.getOrCreate({ cacheKey: '../secret', loadGenerated }), error => error.code === 'invalid_cache_key');
    assert.equal(providerCalls, 0);
    await cache.getOrCreate({ cacheKey: KEY, callType: 'meeting', loadGenerated });
    assert.equal(providerCalls, 1);
});

test('WAV validation rejects truncated, oversized, malformed and missing-data files', async () => {
    const valid = wavFixture();
    assert.equal(await isValidAnnouncementWav(valid), true);
    assert.equal(await isValidAnnouncementWav(valid.slice(0, 45)), false);
    assert.equal(await isValidAnnouncementWav(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)])), false);
    const malformed = new Uint8Array(await valid.arrayBuffer());
    malformed.set(new TextEncoder().encode('junk'), 36);
    assert.equal(await isValidAnnouncementWav(new Blob([malformed])), false);
});

test('IndexedDB adapter reports unsupported storage without touching other APIs', async () => {
    const store = createIndexedDbAudioStore({ indexedDB: null });
    await assert.rejects(store.get(KEY), error => error.code === 'storage_unavailable');
    await assert.rejects(store.put(KEY, wavFixture()), error => error.code === 'storage_unavailable');
    await store.close();
});

test('persistent storage request handles unsupported, already-granted, denied and failed permissions', async () => {
    assert.deepEqual(await requestPersistentAudioStorage({ storage: null }), { supported: false, persisted: false });
    let requests = 0;
    assert.deepEqual(await requestPersistentAudioStorage({ storage: {
        persisted: async () => true,
        persist: async () => { requests++; return true; }
    } }), { supported: true, persisted: true });
    assert.equal(requests, 0);
    assert.deepEqual(await requestPersistentAudioStorage({ storage: {
        persisted: async () => false,
        persist: async () => false
    } }), { supported: true, persisted: false });
    assert.deepEqual(await requestPersistentAudioStorage({ storage: {
        persist: async () => { throw new Error('denied'); }
    } }), { supported: true, persisted: false });
});
