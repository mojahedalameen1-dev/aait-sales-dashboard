/**
 * Announcement WAVs live on the display computer, not in a paid object store.
 * Keys come from the server's SHA-256 speech identity. Nothing is evicted here.
 */
export const MAX_ANNOUNCEMENT_WAV_BYTES = 4 * 1024 * 1024;

const DATABASE_NAME = 'aait-announcement-audio-v1';
const STORE_NAME = 'audio';
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;

function cacheError(code, message) {
    return Object.assign(new Error(message), { code });
}

function validateKey(cacheKey) {
    if (typeof cacheKey !== 'string' || !CACHE_KEY_PATTERN.test(cacheKey)) {
        throw cacheError('invalid_cache_key', 'Invalid announcement audio cache key');
    }
}

function readAscii(bytes, offset, length) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Reject HTML error pages, truncated WAVs and files too large for the API. */
export async function isValidAnnouncementWav(blob) {
    if (!(blob instanceof Blob) || blob.size < 44 || blob.size > MAX_ANNOUNCEMENT_WAV_BYTES) return false;
    let bytes;
    try { bytes = new Uint8Array(await blob.arrayBuffer()); }
    catch { return false; }
    if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const declaredLength = view.getUint32(4, true) + 8;
    if (declaredLength < 44 || declaredLength > bytes.byteLength) return false;
    let validFormat = false;
    let validData = false;
    let offset = 12;
    while (offset + 8 <= declaredLength) {
        const chunkName = readAscii(bytes, offset, 4);
        const chunkLength = view.getUint32(offset + 4, true);
        const contentStart = offset + 8;
        const contentEnd = contentStart + chunkLength;
        if (contentEnd > declaredLength) return false;
        if (chunkName === 'fmt ' && chunkLength >= 16) {
            const format = view.getUint16(contentStart, true);
            const channels = view.getUint16(contentStart + 2, true);
            const sampleRate = view.getUint32(contentStart + 4, true);
            const bitsPerSample = view.getUint16(contentStart + 14, true);
            validFormat = [1, 3].includes(format)
                && channels >= 1 && channels <= 2
                && sampleRate >= 8000 && sampleRate <= 96000
                && [8, 16, 24, 32].includes(bitsPerSample);
        }
        if (chunkName === 'data' && chunkLength > 0) validData = true;
        offset = contentEnd + chunkLength % 2;
    }
    return validFormat && validData;
}

export function createIndexedDbAudioStore({ indexedDB = globalThis.indexedDB } = {}) {
    let connectionPromise = null;

    function open() {
        if (!indexedDB?.open) return Promise.reject(cacheError('storage_unavailable', 'IndexedDB is unavailable'));
        if (connectionPromise) return connectionPromise;
        const pending = new Promise((resolve, reject) => {
            let request;
            let settled = false;
            const fail = () => {
                if (settled) return;
                settled = true;
                reject(cacheError('storage_unavailable', 'Announcement audio storage could not be opened'));
            };
            try { request = indexedDB.open(DATABASE_NAME, 1); }
            catch { fail(); return; }
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onerror = fail;
            request.onblocked = fail;
            request.onsuccess = () => {
                const database = request.result;
                if (settled) { database.close(); return; }
                settled = true;
                database.onversionchange = () => {
                    database.close();
                    connectionPromise = null;
                };
                resolve(database);
            };
        });
        connectionPromise = pending.catch(error => {
            connectionPromise = null;
            throw error;
        });
        return connectionPromise;
    }

    async function transaction(mode, operation) {
        const database = await open();
        return new Promise((resolve, reject) => {
            let transaction;
            let result;
            const fail = () => reject(cacheError('storage_unavailable', 'Announcement audio storage operation failed'));
            try {
                transaction = database.transaction(STORE_NAME, mode);
                transaction.oncomplete = () => resolve(result);
                transaction.onerror = fail;
                transaction.onabort = fail;
                const request = operation(transaction.objectStore(STORE_NAME));
                request.onsuccess = () => { result = request.result; };
                request.onerror = fail;
            } catch { fail(); }
        });
    }

    return {
        async get(cacheKey) {
            validateKey(cacheKey);
            const record = await transaction('readonly', store => store.get(cacheKey));
            return record?.blob instanceof Blob ? record.blob : null;
        },
        async put(cacheKey, blob) {
            validateKey(cacheKey);
            if (!(blob instanceof Blob)) throw cacheError('invalid_audio', 'Announcement audio must be a Blob');
            await transaction('readwrite', store => store.put({ key: cacheKey, blob, createdAt: Date.now() }));
        },
        async close() {
            const current = connectionPromise;
            connectionPromise = null;
            if (current) {
                try { (await current).close(); }
                catch { /* An unavailable store has no open connection to release. */ }
            }
        }
    };
}

/** The browser can decline this request; local persistence is never guaranteed. */
export async function requestPersistentAudioStorage({ storage = globalThis.navigator?.storage } = {}) {
    if (typeof storage?.persist !== 'function') return { supported: false, persisted: false };
    try {
        if (typeof storage.persisted === 'function' && await storage.persisted()) {
            return { supported: true, persisted: true };
        }
        return { supported: true, persisted: Boolean(await storage.persist()) };
    } catch {
        return { supported: true, persisted: false };
    }
}

export function createAnnouncementAudioCache({
    store = createIndexedDbAudioStore(),
    locks = globalThis.navigator?.locks
} = {}) {
    const inFlight = new Map();
    const stats = { hits: 0, misses: 0, providerRequests: 0, storageFailures: 0 };

    async function resolveAudio({ cacheKey, callType, loadGenerated, loadAsset }) {
        let warning;

        async function readLocal() {
            try {
                const blob = await store.get(cacheKey);
                return await isValidAnnouncementWav(blob) ? blob : null;
            } catch {
                stats.storageFailures++;
                warning = 'local_cache_unavailable';
                return null;
            }
        }

        async function saveLocal(blob) {
            try {
                await store.put(cacheKey, blob);
                return true;
            } catch {
                stats.storageFailures++;
                warning = 'local_cache_unavailable';
                return false;
            }
        }

        function localHit(blob) {
            stats.hits++;
            return { blob, cache: 'hit', source: 'indexeddb', persisted: true };
        }

        const cached = await readLocal();
        if (cached) return localHit(cached);

        async function loadAfterLock() {
            // A different tab may have filled IndexedDB while this tab waited.
            const raced = await readLocal();
            if (raced) return localHit(raced);
            if (callType === 'office' && typeof loadAsset === 'function') {
                let asset;
                try { asset = await loadAsset(); }
                catch { /* An unprepared static asset falls back to on-demand generation. */ }
                if (await isValidAnnouncementWav(asset)) {
                    stats.hits++;
                    const persisted = await saveLocal(asset);
                    return { blob: asset, cache: 'hit', source: 'asset', persisted, ...(warning ? { warning } : {}) };
                }
            }
            if (typeof loadGenerated !== 'function') {
                throw cacheError('generation_unavailable', 'Announcement audio generation is unavailable');
            }
            stats.misses++;
            stats.providerRequests++;
            const blob = await loadGenerated();
            if (!await isValidAnnouncementWav(blob)) {
                throw cacheError('invalid_audio', 'The announcement response is not a valid WAV');
            }
            const persisted = await saveLocal(blob);
            return { blob, cache: 'miss', source: 'groq', persisted, ...(warning ? { warning } : {}) };
        }

        if (typeof locks?.request !== 'function') return loadAfterLock();
        let callbackStarted = false;
        try {
            return await locks.request(`aait-call-audio-${cacheKey}`, { mode: 'exclusive' }, () => {
                callbackStarted = true;
                return loadAfterLock();
            });
        } catch (error) {
            // Only fall back if the Lock API itself failed. Never rerun a failed
            // generation callback: that could consume a second provider request.
            if (callbackStarted) throw error;
            return loadAfterLock();
        }
    }

    return {
        getOrCreate(options = {}) {
            try { validateKey(options.cacheKey); }
            catch (error) { return Promise.reject(error); }
            const existing = inFlight.get(options.cacheKey);
            if (existing) return existing;
            const pending = resolveAudio(options).finally(() => {
                if (inFlight.get(options.cacheKey) === pending) inFlight.delete(options.cacheKey);
            });
            inFlight.set(options.cacheKey, pending);
            return pending;
        },
        getStats() { return { ...stats }; }
    };
}
