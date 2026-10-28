import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getPrayerPresentation, getPrayerScheduleEvents } from '../src/prayer-experience.js';
import { createPrayerAlerts } from '../src/prayer-alerts.js';
import { getPrayerSpeechText } from '../src/prayer-audio-assets.js';
import { createPrayerAudioResolver } from '../src/prayer-audio-resolver.js';
import { createAnnouncementAudioCache } from '../src/announcement-audio-cache.js';
import { claimPrayerAudio, createPrayerAudioHandler, getPrayerAudioManifest } from '../server/control/prayer-audio.js';
import { resolveIqamaSettings, IQAMA_PRESET_VERSION } from '../src/prayer-iqama.js';

const DATE = '2026-10-27';
const instant = time => Date.parse(`${DATE}T${time}+03:00`);
const TIMINGS = { Fajr: '04:38', Dhuhr: '11:37', Asr: '14:52', Maghrib: '17:17', Isha: '18:47' };
const payload = (city = 'riyadh') => ({
    city, method: 4, timeZone: 'Asia/Riyadh', fetchedAt: new Date(instant('10:00:00')).toISOString(),
    days: [DATE, '2026-10-28'].map(date => ({ date, timings: { ...TIMINGS } }))
});
const iqama = () => ({ regular: {
    enabled: true, confirmed: true, source: 'جدول اختبار معزول', verifiedAt: DATE, city: 'riyadh',
    intervals: { Fajr: 20, Dhuhr: 15, Asr: 15, Maghrib: 5, Isha: 15 }
} });
function store() {
    const values = new Map();
    return { get: async key => values.get(key), put: async (key, blob) => values.set(key, blob), getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
}
function wavBytes() {
    const bytes = Buffer.alloc(46);
    bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(2, 40);
    return bytes;
}
const wav = () => new Blob([wavBytes()], { type: 'audio/wav' });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the card focuses on the current prayer, then iqama, before returning to the following prayer', () => {
    const at = time => getPrayerPresentation(payload(), instant(time), iqama());
    assert.equal(at('14:42:00').phase, 'approaching');
    assert.equal(at('14:52:00').phase, 'adhan');
    assert.equal(at('14:52:00').prayer.key, 'Asr');
    assert.equal(at('14:52:00').next.key, 'Maghrib');
    assert.equal(at('14:53:00').phase, 'waiting-iqama');
    assert.equal(at('14:53:00').countdownMs, 14 * 60000);
    assert.equal(at('15:07:00').phase, 'iqama');
    assert.equal(at('15:07:59').prayer.key, 'Asr');
    assert.equal(at('15:08:00').phase, 'upcoming');
    assert.equal(at('15:08:00').prayer.key, 'Maghrib');
});

test('the owner-approved manual iqama intervals are enabled exactly as requested without claiming official mosque timing', () => {
    const settings = resolveIqamaSettings();
    assert.equal(settings.presetVersion, IQAMA_PRESET_VERSION);
    assert.equal(settings.regular.enabled, true); assert.equal(settings.regular.confirmed, true);
    assert.deepEqual(settings.regular.intervals, { Fajr: 20, Dhuhr: 15, Asr: 15, Maghrib: 10, Isha: 15 });
    assert.match(settings.regular.source, /يدوية.*مالك اللوحة/);
    const events = getPrayerScheduleEvents(payload(), DATE, settings).filter(event => event.kind === 'iqama');
    assert.deepEqual(events.map(event => event.time), ['04:58', '11:52', '15:07', '17:27', '19:02']);
});

test('the approved timetable upgrades legacy regular settings but preserves Ramadan and later explicit disable/custom settings', () => {
    const ramadan = { enabled: false, source: 'saved Ramadan schedule' };
    const upgraded = resolveIqamaSettings({ regular: { enabled: false }, ramadan });
    assert.equal(upgraded.regular.enabled, true); assert.equal(upgraded.ramadan, ramadan);
    const customized = { ...upgraded, regular: { ...upgraded.regular, enabled: false, intervals: { ...upgraded.regular.intervals, Maghrib: 12 } } };
    assert.equal(resolveIqamaSettings(customized), customized);
    assert.equal(resolveIqamaSettings(customized).regular.intervals.Maghrib, 12);
});

test('without confirmed iqama the card holds the current prayer for five minutes without inventing an iqama', () => {
    const view = time => getPrayerPresentation(payload(), instant(time));
    assert.equal(view('14:56:59').prayer.key, 'Asr');
    assert.equal(view('14:56:59').countdownMs, null);
    assert.equal(view('14:57:00').prayer.key, 'Maghrib');
    assert.equal(getPrayerScheduleEvents(payload(), DATE).filter(event => event.kind === 'iqama').length, 0);
});

test('Isha focus retains tomorrow Fajr as a secondary detail and the clock is always Saudi time', () => {
    const view = getPrayerPresentation(payload(), new Date('2026-10-27T15:47:00Z'), iqama());
    assert.equal(view.phase, 'adhan');
    assert.equal(view.prayer.key, 'Isha');
    assert.equal(view.next.key, 'Fajr');
    assert.equal(view.next.isTomorrow, true);
});

test('a verified iqama profile never follows the card into a different city without new confirmation', () => {
    const events = getPrayerScheduleEvents(payload('jeddah'), DATE, iqama());
    assert.equal(events.length, 5);
    assert.ok(events.every(event => event.cityId === 'jeddah' && event.id.startsWith('jeddah:')));
    assert.equal(getPrayerPresentation(payload('jeddah'), instant('14:53:00'), iqama()).phase, 'adhan');
});

test('the event scheduler reads the exact card snapshot without making a separate times request', async () => {
    let current = new Date(instant('14:51:59'));
    const events = [];
    const scheduler = createPrayerAlerts({
        now: () => current, storage: store(), locks: null,
        service: { load: () => assert.fail('the unified board must not fetch a second prayer schedule') },
        getSnapshot: () => ({ payload: payload(), readyAt: instant('10:00:00') }),
        getIqamaSettings: iqama, onAlert: event => events.push(event)
    });
    current = new Date(instant('14:52:05'));
    scheduler.tick(current); scheduler.tick(current);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].timestamp, instant('14:52:00'));
    assert.equal(getPrayerPresentation(payload(), current, iqama()).prayer.key, events[0].key);
    current = new Date(instant('15:07:00'));
    scheduler.tick(current);
    await settle();
    assert.deepEqual(events.map(event => event.kind), ['adhan', 'iqama']);
    scheduler.destroy();
});

test('late card data still shows the right focus but never plays a stale prayer reminder', async () => {
    const events = [];
    const current = new Date(instant('14:52:10'));
    const scheduler = createPrayerAlerts({ now: () => current, storage: store(), locks: null,
        getSnapshot: () => ({ payload: payload(), readyAt: current.getTime() }), onAlert: event => events.push(event) });
    scheduler.tick(current); await settle(); scheduler.destroy();
    assert.equal(events.length, 0);
    assert.equal(getPrayerPresentation(payload(), current).phase, 'adhan');
});

test('an inactive tab cannot consume the reminder before the visible board receives it', async () => {
    let current = new Date(instant('14:51:59'));
    const storage = store(); const events = [];
    const options = { now: () => current, storage, locks: null, getSnapshot: () => ({ payload: payload(), readyAt: instant('10:00:00') }) };
    const inactive = createPrayerAlerts({ ...options, isActive: () => false, onAlert: () => assert.fail('inactive tab must not consume the prayer') });
    const active = createPrayerAlerts({ ...options, onAlert: event => events.push(event) });
    current = new Date(instant('14:52:00'));
    inactive.tick(current); active.tick(current); await settle();
    assert.equal(events.length, 1); inactive.destroy(); active.destroy();
});

test('a prayer WAV is generated once and survives a new resolver/cache instance, while a voice change creates a new key', async () => {
    const storage = store(); let requests = 0;
    const event = { key: 'Asr', kind: 'adhan' };
    const resolver = voice => createPrayerAudioResolver({
        audioCache: createAnnouncementAudioCache({ store: storage, locks: null }),
        getManifest: () => getPrayerAudioManifest({ GROQ_VOICE: voice }),
        loadGenerated: async () => { requests++; return wav(); }
    });
    await resolver('fahad')(event);
    await resolver('fahad')(event);
    assert.equal(requests, 1);
    await resolver('sultan')(event);
    assert.equal(requests, 2);
});

function response() {
    return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
}
function request(key = 'Asr', kind = 'adhan') {
    const cache = getPrayerAudioManifest({}).assets[key]?.[kind]?.cacheKey || 'x';
    return { method: 'GET', headers: { authorization: 'Bearer display-test-token' }, query: { key, kind, cache } };
}

test('authenticated screen generation accepts only a fixed prayer phrase and returns its matching cache key', async () => {
    let generated = 0;
    const handler = createPrayerAudioHandler({
        verify: async token => { assert.equal(token, 'display-test-token'); return { sub: 'display-test-uid' }; },
        configured: () => true, settings: () => ({ model: 'canopylabs/orpheus-arabic-saudi', voice: 'fahad', speed: .95, sampleRate: 24000, version: 'aait-ar-sa-v1' }),
        claim: async uid => assert.equal(uid, 'display-test-uid'),
        generate: async descriptor => { generated++; assert.equal(descriptor.text, 'حان الآن موعد صلاة العصر.'); return wavBytes(); }
    });
    const res = response(); await handler(request(), res);
    assert.equal(res.code, 200); assert.equal(generated, 1);
    assert.equal(res.headers['Content-Type'], 'audio/wav');
    assert.equal(res.headers['X-Audio-Cache-Key'], request().query.cache);
});

test('unauthorized requests, arbitrary text and prototype properties cannot trigger prayer synthesis', async () => {
    const denied = createPrayerAudioHandler({ verify: async () => { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); }, generate: () => assert.fail() });
    const res = response(); await denied(request(), res); assert.equal(res.code, 401);
    const missingToken = response();
    await denied({ ...request(), headers: {} }, missingToken); assert.equal(missingToken.code, 401);
    const handler = createPrayerAudioHandler({ verify: async () => ({ sub: 'display-test' }), generate: () => assert.fail() });
    for (const [key, kind] of [['Other', 'adhan'], ['constructor', 'name'], ['Asr', '__proto__']]) {
        const result = response(); await handler(request(key, kind), result); assert.equal(result.code, 400);
        assert.equal(getPrayerSpeechText(key, kind), null);
    }
    const stale = request(); stale.query.cache = '0'.repeat(64);
    const result = response(); await handler(stale, result); assert.equal(result.code, 409);
});

test('the public prayer audio manifest contains cache keys and voice metadata, never a provider credential', () => {
    const manifest = getPrayerAudioManifest({ GROQ_API_KEY: 'isolated-secret-fixture', GROQ_VOICE: 'fahad' });
    assert.equal(Object.keys(manifest.assets).length, 5);
    assert.equal(Object.values(manifest.assets).flatMap(value => Object.values(value)).length, 10);
    assert.doesNotMatch(JSON.stringify(manifest), /isolated-secret-fixture|apiKey|GROQ_API_KEY/);
});

test('provider quota rejection returns Retry-After without a generation call', async () => {
    const handler = createPrayerAudioHandler({ verify: async () => ({ sub: 'display-test' }), configured: () => true,
        claim: async () => { throw Object.assign(new Error('quota'), { statusCode: 429, retryAfterMs: 30000 }); }, generate: () => assert.fail() });
    const result = response(); await handler(request(), result);
    assert.equal(result.code, 429); assert.equal(result.headers['Retry-After'], '30');
});

test('distributed prayer quota is private metadata, rejects repeated attempts and caps all screens per phrase daily', async () => {
    let data = null; let revision = 0;
    const options = {
        now: () => instant('14:52:00'), read: async () => ({ data, etag: String(revision) }),
        write: async (path, method, value, headers) => {
            assert.match(path, /^controlPrayerAudioRequests\/2026-10-27\/[a-f0-9]{64}$/);
            assert.equal(method, 'PUT'); assert.equal(headers['if-match'], String(revision)); revision++; data = value;
        }
    };
    const key = getPrayerAudioManifest({}).assets.Asr.adhan.cacheKey;
    await claimPrayerAudio('display-one', key, options);
    await assert.rejects(claimPrayerAudio('display-one', key, options), error => error.statusCode === 429);
    await claimPrayerAudio('display-two', key, options); await claimPrayerAudio('display-three', key, options);
    await assert.rejects(claimPrayerAudio('display-four', key, options), error => error.statusCode === 429);
    assert.equal(data.attempts.length, 3);
    assert.ok(!JSON.stringify(data).includes('display-one'));
    assert.ok(!JSON.stringify(data).includes('RIFF'));
});

test('the board wires notifications to the card snapshot and the existing secure cached audio route', async () => {
    const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const route = await readFile(new URL('../api/control.js', import.meta.url), 'utf8');
    assert.match(main, /getSnapshot: \(\) => prayerCard\.getSnapshot\(\)/);
    assert.match(main, /callReceiver\?\.loadPrayerAudio\(prayer\)/);
    assert.doesNotMatch(main, /createRiyadhPrayerAlerts|createPrayerAudioAssetLoader/);
    assert.match(html, /id="prayer-phase-label"/); assert.match(html, /id="prayer-next-detail"/);
    assert.match(route, /\['prayer-audio', prayerAudioHandler\]/);
});
