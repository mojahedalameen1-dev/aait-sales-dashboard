const DEFAULT_PUBLISH_KEY = '2PACX-1vRMptn5kgbKPmukUxf-9os30G_B3HpvenSged4a5D3GcIS8UgAu9inlHRwe2gq28A';
const TIME_ZONE = 'Asia/Riyadh';
const UPSTREAM_TIMEOUT_MS = 4000;
const UPSTREAM_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const STALE_PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KNOWN_SHEET_GIDS = {
    'فبراير 2026': '951085024',
    'مارس 2026': '1826079126',
    'ابريل 2026': '507439430',
    'مايو 2026': '1614080437',
    'يوليو 2026': '1446268678',
    'اغسطس 2026': '474705831',
    'سبتمبر 2026': '1360390458'
};
const resolvedSheetCache = new Map();
const successfulPayloadCache = new Map();
const ARABIC_MONTH_NAMES = [
    'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو',
    'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'
];

export function getCurrentSheetName() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${ARABIC_MONTH_NAMES[Number(values.month) - 1]} ${values.year}`;
}

export function normalizeArabic(value = '') {
    return value
        .normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .trim()
        .toLowerCase();
}

export function extractSheets(html) {
    const sheets = [];
    const pattern = /items\.push\(\{name:\s*"([^"]+)"[\s\S]*?gid:\s*"(-?\d+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        sheets.push({ name: match[1], gid: match[2] });
    }
    return sheets;
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function fetchWithRetry(url, {
    label = 'Upstream request',
    attempts = UPSTREAM_ATTEMPTS,
    timeoutMs = UPSTREAM_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS
} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const upstreamResponse = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (upstreamResponse.ok) return upstreamResponse;

            const error = new Error(`${label} returned ${upstreamResponse.status}`);
            error.status = upstreamResponse.status;
            throw error;
        } catch (error) {
            lastError = error;
            // Google Sheets occasionally returns a transient 400 for a valid published CSV URL.
            // The publish key and gid are already validated, so retry temporary gateway-style responses.
            const retryableStatus = !error.status
                || [400, 408, 425, 429].includes(error.status)
                || error.status >= 500;
            const willRetry = retryableStatus && attempt < attempts;
            console.warn('[meetings-api] upstream attempt failed', {
                label,
                attempt,
                willRetry,
                error: error.message
            });
            if (!willRetry) break;
            await wait(retryDelayMs * attempt);
        }
    }

    throw lastError || new Error(`${label} failed`);
}

async function resolveSheet(publishKey, sheetName) {
    const cacheKey = `${publishKey}:${normalizeArabic(sheetName)}`;
    const cachedSheet = resolvedSheetCache.get(cacheKey);
    if (cachedSheet) return cachedSheet;

    const knownGid = publishKey === DEFAULT_PUBLISH_KEY
        ? KNOWN_SHEET_GIDS[normalizeArabic(sheetName)]
        : null;
    if (knownGid) {
        const knownSheet = { name: sheetName, gid: knownGid };
        resolvedSheetCache.set(cacheKey, knownSheet);
        return knownSheet;
    }

    const htmlUrl = `https://docs.google.com/spreadsheets/d/e/${publishKey}/pubhtml`;
    const htmlResponse = await fetchWithRetry(htmlUrl, { label: 'Sheets index' });
    const sheets = extractSheets(await htmlResponse.text());
    const target = sheets.find(sheet => normalizeArabic(sheet.name) === normalizeArabic(sheetName));
    if (!target) {
        const error = new Error(`تعذر العثور على تبويب ${sheetName}`);
        error.code = 'SHEET_NOT_FOUND';
        error.availableSheets = sheets.map(sheet => sheet.name).slice(-6);
        throw error;
    }

    resolvedSheetCache.set(cacheKey, target);
    return target;
}

function setResponseCacheHeaders(response, isStale = false) {
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    response.setHeader(
        'Vercel-CDN-Cache-Control',
        isStale
            ? 'public, s-maxage=15, stale-while-revalidate=60'
            : 'public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400'
    );
}

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }

    const requestedKey = typeof request.query?.key === 'string' ? request.query.key.trim() : '';
    const publishKey = /^2PACX-[A-Za-z0-9_-]+$/.test(requestedKey)
        ? requestedKey
        : process.env.GOOGLE_SHEETS_PUBLISH_KEY || DEFAULT_PUBLISH_KEY;
    const sheetName = getCurrentSheetName();
    const payloadCacheKey = `${publishKey}:${normalizeArabic(sheetName)}`;

    try {
        console.info('[meetings-api] request started', { sheetName });
        const target = await resolveSheet(publishKey, sheetName);

        const csvUrl = `https://docs.google.com/spreadsheets/d/e/${publishKey}/pub?gid=${target.gid}&single=true&output=csv`;
        const csvResponse = await fetchWithRetry(csvUrl, { label: 'Sheets CSV' });

        const csvText = await csvResponse.text();
        if (csvText.trim().startsWith('<')) throw new Error('Google Sheets returned HTML instead of CSV');

        const payload = { csvText, sheetName, gid: target.gid };
        successfulPayloadCache.set(payloadCacheKey, { payload, savedAt: Date.now() });
        setResponseCacheHeaders(response);
        console.info('[meetings-api] request completed', {
            sheetName,
            gid: target.gid,
            bytes: Buffer.byteLength(csvText, 'utf8')
        });
        return response.status(200).json(payload);
    } catch (error) {
        if (error.code === 'SHEET_NOT_FOUND') {
            return response.status(404).json({
                error: error.message,
                sheetName,
                availableSheets: error.availableSheets
            });
        }

        const cached = successfulPayloadCache.get(payloadCacheKey);
        if (cached && Date.now() - cached.savedAt <= STALE_PAYLOAD_MAX_AGE_MS) {
            setResponseCacheHeaders(response, true);
            response.setHeader('X-Meetings-Data-Stale', 'true');
            console.warn('[meetings-api] serving stale payload after upstream failure', {
                sheetName,
                ageMs: Date.now() - cached.savedAt,
                error: error.message
            });
            return response.status(200).json({
                ...cached.payload,
                stale: true,
                warning: 'تم عرض آخر بيانات ناجحة بسبب تعذر الوصول المؤقت للمصدر'
            });
        }

        console.error('[meetings-api] request failed', { sheetName, error: error.message });
        return response.status(502).json({ error: 'تعذر الاتصال بمصدر الاجتماعات', detail: error.message });
    }
}
