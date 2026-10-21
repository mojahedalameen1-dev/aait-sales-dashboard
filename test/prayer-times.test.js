import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PRAYER_CITIES, PRAYERS, addPrayerDays, createPrayerService, formatPrayerCountdown,
    formatPrayerTime, getNextPrayer, getRiyadhDate, getTodayPrayerTimings, normalizePrayerPayload
} from '../src/prayer-times.js';
import handler, { fetchPrayerMonth, normalizeAlAdhanCalendar } from '../api/prayer-times.js';

const NOW = Date.parse('2026-10-21T12:00:00+03:00');
const TIMINGS = { Fajr: '04:36', Dhuhr: '11:38', Asr: '14:55', Maghrib: '17:21', Isha: '18:51' };
function payload(overrides = {}) {
    return {
        city: 'riyadh', cityLabel: 'الرياض', method: 4, timeZone: 'Asia/Riyadh',
        fetchedAt: new Date(NOW).toISOString(),
        days: ['2026-10-21', '2026-10-22'].map(date => ({ date, timings: { ...TIMINGS } })), ...overrides
    };
}
function calendar(month = '2026-10', overrides = {}) {
    const count = new Date(`${month}-01T12:00:00Z`);
    count.setUTCMonth(count.getUTCMonth() + 1, 0);
    return {
        code: 200,
        data: Array.from({ length: count.getUTCDate() }, (_, index) => ({
            date: { gregorian: { date: `${String(index + 1).padStart(2, '0')}-${month.slice(5)}-${month.slice(0, 4)}` } },
            timings: Object.fromEntries(PRAYERS.map(prayer => [prayer.key, `${TIMINGS[prayer.key]} (+03)`])),
            meta: { timezone: 'Asia/Riyadh', method: { id: 4 }, latitude: 24.7136, longitude: 46.6753 },
            ...overrides
        }))
    };
}
function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

test('Riyadh date and day arithmetic handle UTC midnight, month and year boundaries', () => {
    assert.equal(getRiyadhDate('2026-10-21T21:00:00Z'), '2026-10-22');
    assert.equal(getRiyadhDate('2026-10-21T20:59:59Z'), '2026-10-21');
    assert.equal(addPrayerDays('2026-12-31'), '2027-01-01');
    assert.equal(addPrayerDays('2028-02-28'), '2028-02-29');
    assert.equal(addPrayerDays('2026-02-30'), null);
    assert.equal(getRiyadhDate('invalid'), null);
    assert.equal(getRiyadhDate(1e20), null);
});

test('next prayer uses Saudi timestamps and rolls from Isha to tomorrow Fajr', () => {
    const upcoming = getNextPrayer(payload(), NOW);
    assert.equal(upcoming.key, 'Asr');
    assert.equal(upcoming.timestamp, Date.parse('2026-10-21T14:55:00+03:00'));
    const tomorrow = getNextPrayer(payload(), Date.parse('2026-10-21T20:00:00+03:00'));
    assert.equal(tomorrow.key, 'Fajr');
    assert.equal(tomorrow.date, '2026-10-22');
    assert.equal(tomorrow.isTomorrow, true);
    assert.equal(tomorrow.remainingMs, 8 * 3600000 + 36 * 60000);
    assert.equal(getNextPrayer(payload({ days: [payload().days[0]] }), Date.parse('2026-10-21T20:00:00+03:00')), null);
});

test('prayer formatting always uses English digits and safe empty states', () => {
    assert.equal(formatPrayerCountdown(3600001), '01:00:01');
    assert.equal(formatPrayerCountdown(-2), '00:00:00');
    assert.equal(formatPrayerCountdown(NaN), '--:--:--');
    assert.equal(formatPrayerTime('00:05'), '12:05 ص');
    assert.equal(formatPrayerTime('13:07 (+03)'), '1:07 م');
    assert.equal(formatPrayerTime('25:09'), '--:--');
});

test('payload validation rejects wrong method, zone, city, dates and malformed times', () => {
    for (const invalid of [
        { method: 3 }, { timeZone: 'UTC' }, { city: 'unknown' },
        { days: [{ date: '2026-10-20', timings: TIMINGS }] },
        { days: [{ date: '2026-10-21', timings: { ...TIMINGS, Isha: '11:38' } }] },
        { days: [{ date: '2026-10-21', timings: { ...TIMINGS, Asr: '25:00' } }] },
        { fetchedAt: '2026-11-01T00:00:00Z' }, { fetchedAt: '2026-08-01T00:00:00Z' }
    ]) assert.equal(normalizePrayerPayload(payload(invalid), { now: NOW }), null);
    assert.equal(getTodayPrayerTimings(payload(), NOW).date, '2026-10-21');
    assert.equal(getNextPrayer(null, NOW), null);
    assert.equal(normalizePrayerPayload(payload(), { city: 'jeddah', now: NOW }), null);
});

test('upstream calendar validates all dates, timezone, method and exact city coordinates', () => {
    const normalized = normalizeAlAdhanCalendar(calendar(), { city: 'riyadh', month: '2026-10' });
    assert.equal(normalized.length, 31);
    assert.deepEqual(normalized[20], { date: '2026-10-21', timings: TIMINGS });
    for (const invalid of [
        { ...calendar(), code: 400 }, { ...calendar(), data: calendar().data.slice(1) },
        calendar('2026-10', { meta: { timezone: 'UTC', method: { id: 4 }, latitude: 24.7136, longitude: 46.6753 } }),
        calendar('2026-10', { meta: { timezone: 'Asia/Riyadh', method: { id: 3 }, latitude: 24.7136, longitude: 46.6753 } }),
        calendar('2026-10', { meta: { timezone: 'Asia/Riyadh', method: { id: 4 }, latitude: 8.8888888, longitude: 7.7777777 } }),
        calendar('2026-10', { timings: { ...TIMINGS, Fajr: undefined } })
    ]) assert.throws(() => normalizeAlAdhanCalendar(invalid, { city: 'riyadh', month: '2026-10' }));
});

test('upstream retries temporary errors and uses fixed city coordinates instead of geocoding', async () => {
    let calls = 0;
    const result = await fetchPrayerMonth('riyadh', '2026-10', {
        retryDelayMs: 0,
        fetchImpl: async url => {
            const request = new URL(url);
            assert.equal(request.pathname, '/v1/calendar/2026/10');
            assert.equal(request.searchParams.get('latitude'), String(PRAYER_CITIES[0].latitude));
            assert.equal(request.searchParams.get('method'), '4');
            assert.equal(request.searchParams.get('timezonestring'), 'Asia/Riyadh');
            calls++;
            return calls === 1 ? new Response('', { status: 503 }) : Response.json(calendar());
        }
    });
    assert.equal(calls, 2);
    assert.equal(result.length, 31);
});

test('service deduplicates requests, persists monthly data, and falls back only to matching current dates', async () => {
    let calls = 0;
    const storage = memoryStorage();
    const service = createPrayerService({ storage, now: () => NOW, fetchImpl: async () => { calls++; return Response.json(payload()); } });
    const [first, second] = await Promise.all([service.load(), service.load()]);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
    await service.load();
    assert.equal(calls, 1);
    const offline = createPrayerService({ storage, now: () => NOW + 60000, fetchImpl: async () => { throw new Error('offline'); } });
    const fallback = await offline.load('riyadh', { force: true });
    assert.equal(fallback.stale, true);
    assert.match(fallback.warning, /تاريخ/);
    const nextDate = Date.parse('2026-10-23T12:00:00+03:00');
    const expired = createPrayerService({ storage, now: () => nextDate, fetchImpl: async () => { throw new Error('offline'); } });
    await assert.rejects(expired.load(), /تعذر تحميل/);
});

test('service never caches malformed responses or silently reuses data from another city', async () => {
    const storage = memoryStorage();
    const invalid = createPrayerService({ storage, now: () => NOW, fetchImpl: async () => Response.json(payload({ method: 3 })) });
    await assert.rejects(invalid.load(), /تعذر تحميل/);
    assert.equal(storage.getItem('aait_prayer_times_v1_riyadh'), null);
    const service = createPrayerService({ storage, now: () => NOW, fetchImpl: async () => Response.json(payload()) });
    await service.load();
    await assert.rejects(service.load('jeddah'), /تعذر تحميل/);
});

test('service marks incomplete tomorrow data and preserves fresher cache when midnight requests finish out of order', async () => {
    let timestamp = Date.parse('2026-10-21T23:59:59+03:00');
    const storage = memoryStorage();
    const finishes = [];
    const service = createPrayerService({ storage, now: () => timestamp, fetchImpl: () => new Promise(resolve => finishes.push(resolve)) });
    const older = service.load();
    timestamp += 2000;
    const newer = service.load();
    const newPayload = payload({
        fetchedAt: new Date(timestamp).toISOString(),
        days: ['2026-10-22', '2026-10-23'].map(date => ({ date, timings: TIMINGS }))
    });
    finishes[1](Response.json(newPayload));
    const current = await newer;
    finishes[0](Response.json(payload({ fetchedAt: new Date(timestamp - 2000).toISOString() })));
    const delayed = await older;
    assert.equal(delayed.fetchedAt, current.fetchedAt);
    assert.equal(delayed.days.at(-1).date, '2026-10-23');

    const partial = createPrayerService({ storage: memoryStorage(), now: () => NOW, fetchImpl: async () => Response.json(payload({ days: [payload().days[0]] })) });
    const incomplete = await partial.load();
    assert.equal(incomplete.stale, true);
    assert.match(incomplete.warning, /فجر الغد/);
});

test('service reads another tab newer valid cache instead of an expired in-memory calendar', async () => {
    let timestamp = NOW;
    let connected = true;
    const storage = memoryStorage();
    const service = createPrayerService({ storage, now: () => timestamp, fetchImpl: async () => {
        if (!connected) throw new Error('offline');
        return Response.json(payload());
    } });
    await service.load();
    timestamp = Date.parse('2026-11-01T12:00:00+03:00');
    connected = false;
    storage.setItem('aait_prayer_times_v1_riyadh', JSON.stringify(payload({
        fetchedAt: new Date(timestamp - 60000).toISOString(),
        days: ['2026-11-01', '2026-11-02'].map(date => ({ date, timings: TIMINGS }))
    })));
    const result = await service.load('riyadh', { force: true });
    assert.equal(result.stale, true);
    assert.equal(getTodayPrayerTimings(result, timestamp).date, '2026-11-01');
});

test('prayer endpoint rejects unsupported cities and methods without calling any upstream', async () => {
    const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
    const cityError = response();
    await handler({ method: 'GET', query: { city: 'https://example.test' } }, cityError);
    assert.equal(cityError.code, 400);
    const methodError = response();
    await handler({ method: 'POST', query: {} }, methodError);
    assert.equal(methodError.code, 405);
    assert.equal(methodError.headers.Allow, 'GET');
});

test('endpoint fetches both calendar months at year rollover and includes tomorrow Fajr', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-31T20:00:00+03:00') });
    const originalFetch = globalThis.fetch;
    const requestedMonths = [];
    globalThis.fetch = async url => {
        const parts = new URL(url).pathname.split('/');
        const month = `${parts.at(-2)}-${parts.at(-1).padStart(2, '0')}`;
        requestedMonths.push(month);
        return Response.json(calendar(month));
    };
    const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    try {
        await handler({ method: 'GET', query: { city: 'riyadh' } }, response);
        assert.equal(response.code, 200);
        assert.deepEqual(requestedMonths.sort(), ['2026-12', '2027-01']);
        assert.equal(response.body.days.length, 62);
        const next = getNextPrayer(response.body);
        assert.equal(next.key, 'Fajr');
        assert.equal(next.date, '2027-01-01');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('endpoint serves marked cached dates after upstream failure and never replaces missing dates with yesterday', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T00:00:00+03:00') });
    const originalFetch = globalThis.fetch;
    const city = PRAYER_CITIES.find(item => item.id === 'hail');
    const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
    globalThis.fetch = async () => Response.json(calendar('2026-10', {
        meta: { timezone: 'Asia/Riyadh', method: { id: 4 }, latitude: city.latitude, longitude: city.longitude }
    }));
    try {
        const fresh = response();
        await handler({ method: 'GET', query: { city: 'hail' } }, fresh);
        assert.equal(fresh.code, 200);
        t.mock.timers.setTime(Date.parse('2026-10-21T13:00:00+03:00'));
        globalThis.fetch = async () => new Response('', { status: 404 });
        const stale = response();
        await handler({ method: 'GET', query: { city: 'hail' } }, stale);
        assert.equal(stale.code, 200);
        assert.equal(stale.body.stale, true);
        assert.equal(stale.headers['X-Prayer-Data-Stale'], 'true');
        assert.equal(getTodayPrayerTimings(stale.body).date, '2026-10-21');
        t.mock.timers.setTime(Date.parse('2026-11-01T13:00:00+03:00'));
        const unavailable = response();
        await handler({ method: 'GET', query: { city: 'hail' } }, unavailable);
        assert.equal(unavailable.code, 502);
        assert.equal(unavailable.body.days, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
