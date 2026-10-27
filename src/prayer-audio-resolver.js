/** Reuses the existing persistent audio cache; no provider key or arbitrary text reaches the browser. */
export function createPrayerAudioResolver({ audioCache, getManifest, loadGenerated }) {
    return async event => {
        const manifest = await getManifest();
        const cacheKey = manifest?.assets?.[event.key]?.[event.kind]?.cacheKey;
        if (!/^[a-f0-9]{64}$/.test(cacheKey || '')) throw new Error('إعداد صوت الصلاة غير متاح');
        const result = await audioCache.getOrCreate({
            cacheKey, callType: 'prayer',
            loadGenerated: () => loadGenerated({ key: event.key, kind: event.kind, cacheKey })
        });
        return result.blob;
    };
}
