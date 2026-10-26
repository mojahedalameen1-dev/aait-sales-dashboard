const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_KEYS = 10000;
const MAX_MANIFEST_CHARACTERS = 1024 * 1024;
const MANIFEST_URL = '/audio/calls/manifest.json';

export function parseAnnouncementAssetManifest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.version !== 1 || !Array.isArray(payload.keys)
        || payload.keys.length > MAX_MANIFEST_KEYS
        || payload.keys.some(key => typeof key !== 'string' || !CACHE_KEY_PATTERN.test(key))) return null;
    return new Set(payload.keys);
}

/** Missing optional office assets must not cause speculative WAV 404 requests. */
export function createAnnouncementAssetLoader({ fetcher = globalThis.fetch } = {}) {
    let manifestPromise = null;

    async function readManifest() {
        if (typeof fetcher !== 'function') return null;
        try {
            const response = await fetcher(MANIFEST_URL, { cache: 'no-cache' });
            if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
            const source = await response.text();
            if (source.length > MAX_MANIFEST_CHARACTERS) return null;
            return parseAnnouncementAssetManifest(JSON.parse(source));
        } catch { return null; }
    }

    return async function loadAsset(cacheKey) {
        if (typeof cacheKey !== 'string' || !CACHE_KEY_PATTERN.test(cacheKey)) return null;
        manifestPromise ||= readManifest();
        const keys = await manifestPromise;
        if (!keys?.has(cacheKey)) return null;
        try {
            // Only a validated hash is interpolated into a fixed same-origin path.
            const response = await fetcher(`/audio/calls/${cacheKey}.wav`, { cache: 'force-cache' });
            if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/')) return null;
            return await response.blob();
        } catch { return null; }
    };
}
