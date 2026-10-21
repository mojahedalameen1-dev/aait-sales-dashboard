import {
    PRAYER_METHOD, PRAYER_TIME_ZONE, addPrayerDays, getPrayerCity,
    getRiyadhDate, normalizePrayerDay, normalizePrayerPayload
} from '../src/prayer-times.js';

const UPSTREAM_TIMEOUT_MS = 3500;
const UPSTREAM_ATTEMPTS = 2;
const MONTH_FRESH_MS = 12 * 60 * 60 * 1000;
const MONTH_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const monthlyCache = new Map();
const pendingMonths = new Map();

export function normalizeAlAdhanCalendar(payload, { city, month }) {
    const selectedCity = getPrayerCity(city);
    if (!selectedCity || payload?.code !== 200 || !Array.isArray(payload.data)
        || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid prayer calendar response');
    const expectedCount = new Date(`${month}-01T12:00:00Z`);
    expectedCount.setUTCMonth(expectedCount.getUTCMonth() + 1, 0);
    if (payload.data.length !== expectedCount.getUTCDate()) throw new Error('Incomplete prayer calendar response');
    const days = payload.data.map(item => {
        const meta = item?.meta;
        if (meta?.method?.id !== PRAYER_METHOD || meta.timezone !== PRAYER_TIME_ZONE
            || !Number.isFinite(meta.latitude) || !Number.isFinite(meta.longitude)
            || Math.abs(meta.latitude - selectedCity.latitude) > 0.05
            || Math.abs(meta.longitude - selectedCity.longitude) > 0.05) {
            throw new Error('Prayer calendar location, time zone or calculation method does not match');
        }
        const match = item.date?.gregorian?.date?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        const day = match && normalizePrayerDay({ date: `${match[3]}-${match[2]}-${match[1]}`, timings: item.timings });
        if (!day || !day.date.startsWith(`${month}-`)) throw new Error('Invalid prayer calendar date or timing');
        return day;
    });
    if (new Set(days.map(day => day.date)).size !== days.length) throw new Error('Duplicate prayer calendar dates');
    return days.sort((first, second) => first.date.localeCompare(second.date));
}

export async function fetchPrayerMonth(city, month, {
    fetchImpl = globalThis.fetch, timeoutMs = UPSTREAM_TIMEOUT_MS, attempts = UPSTREAM_ATTEMPTS, retryDelayMs = 200
} = {}) {
    const selectedCity = getPrayerCity(city);
    if (!selectedCity || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Unsupported prayer city or month');
    const [year, monthNumber] = month.split('-');
    const url = new URL(`https://api.aladhan.com/v1/calendar/${year}/${Number(monthNumber)}`);
    url.search = new URLSearchParams({
        latitude: String(selectedCity.latitude), longitude: String(selectedCity.longitude),
        method: String(PRAYER_METHOD), timezonestring: PRAYER_TIME_ZONE, calendarMethod: 'UAQ'
    }).toString();
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url.toString(), { signal: controller.signal });
            if (!response.ok) {
                const error = new Error(`Prayer calendar returned ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return normalizeAlAdhanCalendar(await response.json(), { city: selectedCity.id, month });
        } catch (error) {
            lastError = error;
            if (attempt + 1 >= attempts || (error.status && error.status < 500 && ![408, 425, 429].includes(error.status))) break;
        } finally {
            clearTimeout(timer);
        }
        if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw lastError || new Error('Prayer calendar request failed');
}

async function getPrayerMonth(city, month, timestamp) {
    const key = `${city}:${month}`;
    const cached = monthlyCache.get(key);
    if (cached && timestamp - Date.parse(cached.fetchedAt) < MONTH_FRESH_MS) return cached;
    if (pendingMonths.has(key)) return pendingMonths.get(key);
    const pending = (async () => {
        try {
            const days = await fetchPrayerMonth(city, month);
            const result = { days, fetchedAt: new Date().toISOString() };
            monthlyCache.set(key, result);
            for (const [savedKey, saved] of monthlyCache) {
                if (timestamp - Date.parse(saved.fetchedAt) > MONTH_MAX_AGE_MS) monthlyCache.delete(savedKey);
            }
            return result;
        } catch (error) {
            if (cached && timestamp - Date.parse(cached.fetchedAt) <= MONTH_MAX_AGE_MS) return { ...cached, stale: true };
            throw error;
        } finally {
            pendingMonths.delete(key);
        }
    })();
    pendingMonths.set(key, pending);
    return pending;
}

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    const requestedCity = request.query?.city === undefined ? 'riyadh' : request.query.city;
    const city = getPrayerCity(requestedCity);
    if (!city) return response.status(400).json({ error: 'المدينة المختارة غير متاحة لمواقيت الصلاة' });
    const timestamp = Date.now();
    const today = getRiyadhDate(timestamp);
    const tomorrow = addPrayerDays(today);
    const months = [...new Set([today.slice(0, 7), tomorrow.slice(0, 7)])];
    try {
        const results = await Promise.allSettled(months.map(month => getPrayerMonth(city.id, month, timestamp)));
        if (results[0].status === 'rejected') throw results[0].reason;
        const calendars = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        const hasMissingMonth = results.some(result => result.status === 'rejected');
        const stale = hasMissingMonth || calendars.some(calendar => calendar.stale);
        const payload = normalizePrayerPayload({
            city: city.id, cityLabel: city.label, timeZone: PRAYER_TIME_ZONE, method: PRAYER_METHOD,
            days: calendars.flatMap(calendar => calendar.days),
            fetchedAt: new Date(Math.min(...calendars.map(calendar => Date.parse(calendar.fetchedAt)))).toISOString(),
            ...(stale ? { stale: true, warning: hasMissingMonth
                ? 'مواقيت اليوم متاحة؛ تعذر تحميل فجر الغد مؤقتًا'
                : 'تعذر التحديث؛ تُعرض مواقيت محفوظة مطابقة لتاريخ اليوم' } : {})
        }, { city: city.id, now: timestamp });
        if (!payload) throw new Error('No valid current-day prayer calendar');
        // A fresh response must expire before Riyadh midnight, including at month rollover.
        const secondsUntilMidnight = Math.ceil((Date.parse(`${tomorrow}T00:00:00+03:00`) - timestamp) / 1000);
        response.setHeader('Vercel-CDN-Cache-Control', `public, s-maxage=${Math.max(1, Math.min(stale ? 60 : 3600, secondsUntilMidnight))}`);
        if (stale) response.setHeader('X-Prayer-Data-Stale', 'true');
        return response.status(200).json(payload);
    } catch (error) {
        response.setHeader('Cache-Control', 'no-store');
        console.warn('[prayer-times-api] request failed', { city: city.id, error: error.message });
        return response.status(502).json({ error: 'تعذر الاتصال بمصدر مواقيت الصلاة، أعد المحاولة لاحقًا' });
    }
}
