export const PRAYER_TIME_ZONE = 'Asia/Riyadh';
export const PRAYER_METHOD = 4;
export const PRAYER_CITIES = Object.freeze([
    { id: 'riyadh', label: 'الرياض', latitude: 24.7136, longitude: 46.6753 },
    { id: 'jeddah', label: 'جدة', latitude: 21.4858, longitude: 39.1925 },
    { id: 'makkah', label: 'مكة المكرمة', latitude: 21.4225, longitude: 39.8262 },
    { id: 'madinah', label: 'المدينة المنورة', latitude: 24.4672, longitude: 39.6111 },
    { id: 'dammam', label: 'الدمام', latitude: 26.4207, longitude: 50.0888 },
    { id: 'buraidah', label: 'بريدة', latitude: 26.3592, longitude: 43.9818 },
    { id: 'abha', label: 'أبها', latitude: 18.2164, longitude: 42.5053 },
    { id: 'tabuk', label: 'تبوك', latitude: 28.3838, longitude: 36.5550 },
    { id: 'hail', label: 'حائل', latitude: 27.5114, longitude: 41.7208 }
].map(city => Object.freeze(city)));
export const PRAYERS = Object.freeze([
    { key: 'Fajr', label: 'الفجر' },
    { key: 'Dhuhr', label: 'الظهر' },
    { key: 'Asr', label: 'العصر' },
    { key: 'Maghrib', label: 'المغرب' },
    { key: 'Isha', label: 'العشاء' }
].map(prayer => Object.freeze(prayer)));

const CACHE_PREFIX = 'aait_prayer_times_v1_';
const CACHE_FRESH_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PRAYER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

function toTimestamp(value) {
    const timestamp = value instanceof Date ? value.getTime()
        : typeof value === 'number' ? value
            : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? timestamp : NaN;
}

export function getPrayerCity(city = 'riyadh') {
    return typeof city === 'string'
        ? PRAYER_CITIES.find(item => item.id === city.trim().toLowerCase()) || null
        : null;
}

export function getRiyadhDate(now = Date.now()) {
    const timestamp = toTimestamp(now);
    if (!Number.isFinite(timestamp)) return null;
    const parts = Object.fromEntries(dateFormatter.formatToParts(timestamp)
        .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isPrayerDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function addPrayerDays(date, amount = 1) {
    if (!isPrayerDate(date) || !Number.isInteger(amount)) return null;
    const shifted = new Date(`${date}T12:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + amount);
    return shifted.toISOString().slice(0, 10);
}

export function normalizePrayerTime(value) {
    if (typeof value !== 'string') return null;
    // AlAdhan monthly calendars append the offset, e.g. "04:36 (+03)".
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?:\s+\(\+03(?::00)?\))?$/);
    return match ? `${match[1]}:${match[2]}` : null;
}

export function normalizePrayerDay(day) {
    if (!day || !isPrayerDate(day.date) || !day.timings || typeof day.timings !== 'object') return null;
    const timings = {};
    let previous = -1;
    for (const prayer of PRAYERS) {
        const time = normalizePrayerTime(day.timings[prayer.key]);
        if (!time) return null;
        const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        if (minutes <= previous) return null;
        previous = minutes;
        timings[prayer.key] = time;
    }
    return { date: day.date, timings };
}

export function normalizePrayerPayload(payload, { city = payload?.city, now = Date.now(), requireToday = true } = {}) {
    const selectedCity = getPrayerCity(city);
    const timestamp = toTimestamp(now);
    if (!payload || !selectedCity || payload.city !== selectedCity.id
        || payload.timeZone !== PRAYER_TIME_ZONE || payload.method !== PRAYER_METHOD
        || !Array.isArray(payload.days) || !payload.days.length || payload.days.length > 62
        || !Number.isFinite(timestamp)) return null;

    const fetchedAt = typeof payload.fetchedAt === 'string' ? Date.parse(payload.fetchedAt) : NaN;
    if (!Number.isFinite(fetchedAt) || fetchedAt - timestamp > FUTURE_CLOCK_TOLERANCE_MS
        || timestamp - fetchedAt > CACHE_MAX_AGE_MS) return null;
    const days = payload.days.map(normalizePrayerDay);
    if (days.some(day => !day) || new Set(days.map(day => day.date)).size !== days.length) return null;
    days.sort((first, second) => first.date.localeCompare(second.date));
    if (requireToday && !days.some(day => day.date === getRiyadhDate(timestamp))) return null;
    return {
        city: selectedCity.id,
        cityLabel: selectedCity.label,
        timeZone: PRAYER_TIME_ZONE,
        method: PRAYER_METHOD,
        days,
        fetchedAt: new Date(fetchedAt).toISOString(),
        ...(payload.stale === true ? { stale: true } : {}),
        ...(typeof payload.warning === 'string' && payload.warning.trim()
            ? { warning: payload.warning.trim().slice(0, 180) } : {})
    };
}

export function getTodayPrayerTimings(payload, now = Date.now()) {
    const normalized = normalizePrayerPayload(payload, { now });
    return normalized?.days.find(day => day.date === getRiyadhDate(now)) || null;
}

export function getNextPrayer(payload, now = Date.now()) {
    const timestamp = toTimestamp(now);
    const normalized = normalizePrayerPayload(payload, { now: timestamp });
    if (!normalized) return null;
    const today = getRiyadhDate(timestamp);
    const tomorrow = addPrayerDays(today);
    for (const day of normalized.days) {
        if (day.date !== today && day.date !== tomorrow) continue;
        for (const prayer of PRAYERS) {
            const time = day.timings[prayer.key];
            // Saudi Arabia uses UTC+03:00 all year; never parse in the device's zone.
            const prayerTimestamp = Date.parse(`${day.date}T${time}:00+03:00`);
            if (prayerTimestamp >= timestamp) {
                return {
                    ...prayer, date: day.date, time, timestamp: prayerTimestamp,
                    remainingMs: prayerTimestamp - timestamp, isTomorrow: day.date === tomorrow
                };
            }
        }
    }
    return null;
}

export function formatPrayerTime(value) {
    const time = normalizePrayerTime(value);
    if (!time) return '--:--';
    const hour = Number(time.slice(0, 2));
    return `${hour % 12 || 12}:${time.slice(3)} ${hour >= 12 ? 'م' : 'ص'}`;
}

export function formatPrayerCountdown(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '--:--:--';
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(value => String(value).padStart(2, '0')).join(':');
}

function browserStorage() {
    try { return globalThis.localStorage || null; } catch { return null; }
}

export function createPrayerService({ fetchImpl = globalThis.fetch, storage = browserStorage(), now = Date.now, timeoutMs = 12000 } = {}) {
    const memory = new Map();
    const requests = new Map();

    function cachedPayload(city, timestamp) {
        const inMemory = normalizePrayerPayload(memory.get(city), { city, now: timestamp });
        let persisted = null;
        try {
            persisted = normalizePrayerPayload(JSON.parse(storage?.getItem(`${CACHE_PREFIX}${city}`) || 'null'), { city, now: timestamp });
        } catch { /* Storage is optional. */ }
        // Another open dashboard may have saved the new month while this tab was offline.
        const normalized = persisted && (!inMemory || Date.parse(persisted.fetchedAt) > Date.parse(inMemory.fetchedAt))
            ? persisted : inMemory;
        if (normalized) memory.set(city, normalized);
        return normalized;
    }

    async function load(city = 'riyadh', { force = false } = {}) {
        const selectedCity = getPrayerCity(city);
        if (!selectedCity) throw new Error('المدينة المختارة غير متاحة لمواقيت الصلاة');
        const timestamp = toTimestamp(now());
        if (!Number.isFinite(timestamp)) throw new Error('تعذر قراءة الوقت الحالي لمواقيت الصلاة');
        const currentDate = getRiyadhDate(timestamp);
        const cached = cachedPayload(selectedCity.id, timestamp);
        const hasTomorrow = cached?.days.some(day => day.date === addPrayerDays(currentDate));
        if (!force && cached && hasTomorrow && !cached.stale && timestamp - Date.parse(cached.fetchedAt) < CACHE_FRESH_MS) return cached;

        const requestKey = `${selectedCity.id}:${currentDate}`;
        if (requests.has(requestKey)) return requests.get(requestKey);
        const pending = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const query = new URLSearchParams({ city: selectedCity.id, date: currentDate });
                const response = await fetchImpl(`/api/prayer-times?${query}`, { signal: controller.signal });
                if (!response.ok) throw new Error(`Prayer times request returned ${response.status}`);
                let payload = normalizePrayerPayload(await response.json(), { city: selectedCity.id, now: now() });
                if (!payload) throw new Error('Prayer times response is invalid or has no current-day schedule');
                const completedAt = toTimestamp(now());
                if (!payload.days.some(item => item.date === addPrayerDays(getRiyadhDate(completedAt)))) {
                    payload = { ...payload, stale: true, warning: 'مواقيت اليوم متاحة؛ تعذر تحميل فجر الغد مؤقتًا' };
                }
                // Requests from opposite sides of midnight may finish out of order.
                const newer = cachedPayload(selectedCity.id, completedAt);
                if (newer && Date.parse(newer.fetchedAt) > Date.parse(payload.fetchedAt)) return newer;
                memory.set(selectedCity.id, payload);
                try { storage?.setItem(`${CACHE_PREFIX}${selectedCity.id}`, JSON.stringify(payload)); } catch { /* Storage may be full or blocked. */ }
                return payload;
            } catch {
                // Revalidate at completion: midnight may have passed while the request was pending.
                const fallback = cachedPayload(selectedCity.id, toTimestamp(now()));
                if (!fallback) throw new Error('تعذر تحميل مواقيت الصلاة، أعد المحاولة عند توفر الاتصال');
                const stalePayload = {
                    ...fallback,
                    stale: true,
                    warning: 'تعذر تحديث المواقيت؛ تُعرض آخر مواقيت محفوظة لهذا التاريخ'
                };
                memory.set(selectedCity.id, stalePayload);
                return stalePayload;
            } finally {
                clearTimeout(timer);
                requests.delete(requestKey);
            }
        })();
        requests.set(requestKey, pending);
        return pending;
    }

    return { load, clear() { memory.clear(); } };
}
