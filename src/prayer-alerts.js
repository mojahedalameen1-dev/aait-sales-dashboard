import { PRAYERS, getRiyadhDate, createPrayerService } from './prayer-times.js';

const STORAGE_KEY = 'aait_prayer_alerts_riyadh_v1';
const GRACE_PERIOD_MS = 45000;

function readMarkers(storage) {
    try {
        const value = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
        return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
    } catch { return new Set(); }
}

export function createRiyadhPrayerAlerts({
    service = createPrayerService(),
    storage = globalThis.localStorage,
    now = () => new Date(),
    onAlert = () => {}
} = {}) {
    let payload = null;
    let day = '';
    let loading = false;
    let retryAt = 0;
    let destroyed = false;
    const markers = readMarkers(storage);

    async function load(force = false) {
        if (destroyed || loading || (!force && Date.now() < retryAt)) return;
        loading = true;
        try {
            payload = await service.load('riyadh', { force });
            retryAt = Date.now() + (payload.stale ? 5 : 12) * 60 * 1000;
        } catch {
            retryAt = Date.now() + 60 * 1000;
        } finally {
            loading = false;
        }
    }

    function tick(time = now()) {
        if (destroyed) return;
        const currentDay = getRiyadhDate(time);
        if (day !== currentDay) {
            day = currentDay;
            payload = null;
            retryAt = 0;
            void load();
        }
        if (!payload) return;
        const schedule = payload.days?.find(item => item.date === currentDay);
        if (!schedule) return;
        const currentTime = time.getTime();
        for (const prayer of PRAYERS) {
            const rawTime = schedule.timings?.[prayer.key];
            if (!rawTime || !/^\d{2}:\d{2}$/.test(rawTime)) continue;
            const instant = Date.parse(`${currentDay}T${rawTime}:00+03:00`);
            const marker = `${currentDay}:${prayer.key}`;
            if (!Number.isFinite(instant) || currentTime < instant || currentTime - instant > GRACE_PERIOD_MS || markers.has(marker)) continue;
            // Persist the at-most-once marker before notifying; a refresh cannot replay it.
            markers.add(marker);
            try { storage?.setItem(STORAGE_KEY, JSON.stringify([...markers].slice(-120))); }
            catch { /* In-memory dedupe remains active for this page session. */ }
            onAlert({ date: currentDay, key: prayer.key, label: prayer.label, time: rawTime, city: 'الرياض' });
        }
    }

    tick(now());
    return {
        tick,
        refresh: () => load(true),
        destroy() { destroyed = true; }
    };
}
