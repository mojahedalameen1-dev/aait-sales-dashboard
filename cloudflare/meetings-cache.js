const FRESH_SECONDS = 30;
const STALE_SECONDS = 24 * 60 * 60;

/** The stale copy is only used if the fresh read fails; it never receives a new fetch timestamp. */
export async function withMeetingsEdgeCache({ url, cache, context, sourceKey, sheetName, fetchFresh, now = Date.now }) {
    if (!cache) return fetchFresh();
    const key = kind => {
        const target = new URL(`/__aait_cache/meetings-v2/${kind}`, url.origin);
        target.search = new URLSearchParams({ source: sourceKey, sheet: sheetName }).toString();
        return new Request(target);
    };
    async function read(kind) {
        try { return await cache.match(key(kind)); } catch { return null; }
    }
    function responseWithHeaders(response, body, state, extra = {}) {
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        headers.delete('Vercel-CDN-Cache-Control');
        headers.set('X-Edge-Cache', state);
        for (const [name, value] of Object.entries(extra)) headers.set(name, value);
        return new Response(body, { status: 200, headers });
    }

    const fresh = await read('fresh');
    if (fresh) return responseWithHeaders(fresh, fresh.body, 'HIT');
    const response = await fetchFresh();
    if ([500, 502, 503, 504].includes(response.status)) {
        const saved = await read('fallback');
        const data = await saved?.json().catch(() => null);
        const fetchedAt = Date.parse(data?.fetchedAt);
        if (data?.sheetName === sheetName && typeof data.csvText === 'string' && Number.isFinite(fetchedAt)
            && fetchedAt <= now() && now() - fetchedAt <= STALE_SECONDS * 1000) {
            return responseWithHeaders(saved, JSON.stringify({ ...data, stale: true, warning: 'تعذر تحديث الاجتماعات؛ نعرض آخر بيانات ناجحة' }),
                'STALE', { 'X-Meetings-Data-Stale': 'true', 'Content-Type': 'application/json; charset=utf-8' });
        }
    }
    if (response.ok && !response.headers.has('X-Meetings-Data-Stale')) {
        const data = await response.clone().json().catch(() => null);
        if (data?.sheetName === sheetName && typeof data.csvText === 'string' && !data.stale) {
            const save = (kind, ttl) => Promise.resolve().then(() => {
                const headers = new Headers(response.headers);
                headers.set('Cache-Control', `public, max-age=${ttl}`);
                headers.delete('Vercel-CDN-Cache-Control');
                return cache.put(key(kind), new Response(JSON.stringify(data), { status: 200, headers }));
            });
            const write = Promise.allSettled([save('fresh', FRESH_SECONDS), save('fallback', STALE_SECONDS)]);
            if (context?.waitUntil) context.waitUntil(write);
            else await write;
        }
    }
    return response;
}
