import meetingsApi, { getCurrentSheetName, getMeetingsPublishKey } from '../api/meetings.js';
import prayerTimesApi from '../api/prayer-times.js';
import controlApi from '../api/control.js';
import { withMeetingsEdgeCache } from './meetings-cache.js';
import { cleanupExpiredCalls } from '../server/control/retention.js';

const SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' https://docs.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseio.com https://*.firebasedatabase.app; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

class VercelResponseAdapter {
    constructor() {
        this.statusCode = 200;
        this.headers = new Headers(SECURITY_HEADERS);
    }

    status(code) {
        this.statusCode = code;
        return this;
    }

    setHeader(name, value) {
        if (Array.isArray(value)) {
            this.headers.delete(name);
            for (const item of value) this.headers.append(name, String(item));
        } else {
            this.headers.set(name, String(value));
        }
        return this;
    }

    json(payload) {
        if (!this.headers.has('Content-Type')) this.headers.set('Content-Type', 'application/json; charset=utf-8');
        return new Response(JSON.stringify(payload), { status: this.statusCode, headers: this.headers });
    }

    send(payload) {
        return new Response(payload, { status: this.statusCode, headers: this.headers });
    }
}

function getRequestQuery(url) {
    return Object.fromEntries(url.searchParams.entries());
}

function makeLegacyRequest(request, url) {
    const headers = Object.fromEntries(request.headers.entries());
    const address = request.headers.get('cf-connecting-ip') || '';
    // Do not let the caller provide the address for the persistent login limiter.
    headers['x-forwarded-for'] = address;
    headers['x-forwarded-proto'] = url.protocol.slice(0, -1);
    return {
        url: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        query: getRequestQuery(url),
        async *[Symbol.asyncIterator]() {
            if (!request.body) return;
            const reader = request.body.getReader();
            const decoder = new TextDecoder();
            let bytes = 0;
            let complete = false;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { complete = true; break; }
                    bytes += value.byteLength;
                    if (bytes > 12000) {
                        throw Object.assign(new Error('حجم الطلب أكبر من المسموح'), { statusCode: 413 });
                    }
                    yield decoder.decode(value, { stream: true });
                }
                yield decoder.decode();
            } finally {
                if (!complete) await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        },
        socket: {
            encrypted: url.protocol === 'https:',
            remoteAddress: address
        }
    };
}

function getEdgeTtl(response) {
    if (response.status !== 200) return 0;
    const directive = response.headers.get('Vercel-CDN-Cache-Control') || '';
    const match = /(?:^|,)\s*s-maxage=(\d+)/i.exec(directive);
    return match ? Math.max(0, Math.min(Number(match[1]), 86400)) : 0;
}

async function runApi(request, env, context, url) {
    const cacheable = request.method === 'GET'
        && url.pathname === '/api/prayer-times';
    const cache = globalThis.caches?.default;
    const cacheKey = cacheable && cache ? new Request(url.toString(), { method: 'GET' }) : null;

    if (cacheKey) {
        const cached = await cache.match(cacheKey);
        if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
            headers.set('X-Edge-Cache', 'HIT');
            return new Response(cached.body, { status: cached.status, headers });
        }
    }

    const legacyRequest = makeLegacyRequest(request, url);
    const legacyResponse = new VercelResponseAdapter();
    let handler;

    if (url.pathname === '/api/meetings') {
        handler = meetingsApi;
    } else if (url.pathname === '/api/prayer-times') {
        handler = prayerTimesApi;
    } else if (url.pathname === '/api/control' || url.pathname.startsWith('/api/control/')) {
        const pathFromUrl = url.pathname.slice('/api/control/'.length).split('/')[0];
        legacyRequest.query.path = pathFromUrl || url.searchParams.get('path') || '';
        handler = controlApi;
    } else {
        legacyResponse.status(404);
        return legacyResponse.json({ error: 'Not found' });
    }

    let response;
    try {
        response = await handler(legacyRequest, legacyResponse);
    } catch (error) {
        console.error('[worker-api] handler failed', { path: url.pathname, message: error?.message });
        response = legacyResponse.status(500).json({ error: 'تعذر إكمال الطلب' });
    }
    if (!(response instanceof Response)) {
        response = legacyResponse.status(500).json({ error: 'تعذر إكمال الطلب' });
    }

    const ttl = cacheable ? getEdgeTtl(response) : 0;
    if (cacheKey && ttl > 0) {
        const cachedHeaders = new Headers(response.headers);
        cachedHeaders.set('Cache-Control', `public, max-age=${ttl}`);
        cachedHeaders.delete('Vercel-CDN-Cache-Control');
        const cachedResponse = new Response(response.clone().body, {
            status: response.status,
            headers: cachedHeaders
        });
        const write = cache.put(cacheKey, cachedResponse);
        if (context?.waitUntil) context.waitUntil(write);
        else await write;
    }

    const headers = new Headers(response.headers);
    headers.set('X-Edge-Cache', 'MISS');
    return new Response(response.body, { status: response.status, headers });
}

export default {
    async scheduled() {
        const removed = await cleanupExpiredCalls();
        console.info('[call-retention] scheduled cleanup', { removed });
    },
    async fetch(request, env, context) {
        const url = new URL(request.url);
        const isApi = url.pathname.startsWith('/api/');
        if (url.protocol === 'http:' && url.hostname.endsWith('.workers.dev')) {
            if (request.method === 'GET' || request.method === 'HEAD') {
                url.protocol = 'https:';
                return Response.redirect(url, 308);
            }
            return new VercelResponseAdapter().status(403).json({ error: 'HTTPS required' });
        }
        if (isApi) {
            if (request.method === 'GET' && url.pathname === '/api/meetings') {
                return withMeetingsEdgeCache({
                    url, cache: globalThis.caches?.default, context, sheetName: getCurrentSheetName(),
                    // Match the adapter's last-value semantics for repeated query parameters.
                    sourceKey: getMeetingsPublishKey(getRequestQuery(url).key),
                    fetchFresh: () => runApi(request, env, context, url)
                });
            }
            return runApi(request, env, context, url);
        }

        if (url.pathname === '/favicon.ico') {
            return Response.redirect(new URL('/logo.svg', url), 308);
        }

        if (url.pathname === '/control' || url.pathname === '/control/') {
            return env.ASSETS.fetch(new URL('/control/index.html', url));
        }

        return env.ASSETS.fetch(request);
    }
};
