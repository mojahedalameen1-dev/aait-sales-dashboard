import { getRiyadhDate, createPrayerService } from './prayer-times.js';
import { getPrayerScheduleEvents } from './prayer-experience.js';

const STORAGE_KEY = 'aait_prayer_alerts_riyadh_v1';
const GRACE_PERIOD_MS = 15000;

function readMarkers(storage) {
    try {
        const value = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
        return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []);
    } catch { return new Set(); }
}

export function createPrayerAlerts({
    service = createPrayerService(),
    getSnapshot,
    storage = globalThis.localStorage,
    now = () => new Date(),
    onAlert = () => {},
    isActive = () => true,
    getIqamaSettings = () => null,
    locks = globalThis.navigator?.locks
} = {}) {
    let payload = null;
    let day = '';
    let loading = false;
    let retryAt = 0;
    let destroyed = false;
    let payloadReadyAt = Infinity;
    let suppressThrough = 0;
    const sessionStartedAt = now().getTime();
    const inFlight = new Set();
    const sessionMarkers = new Set();

    async function load(force = false) {
        if (destroyed || loading || (!force && Date.now() < retryAt)) return;
        loading = true;
        try {
            payload = await service.load('riyadh', { force });
            payloadReadyAt = now().getTime();
            retryAt = Date.now() + (payload.stale ? 5 : 12) * 60 * 1000;
        } catch {
            retryAt = Date.now() + 60 * 1000;
        } finally {
            loading = false;
        }
    }

    function stored(marker, kind) {
        if (sessionMarkers.has(marker)) return true;
        const latest = readMarkers(storage);
        if (latest.has(marker)) { sessionMarkers.add(marker); return true; }
        // Keep old adhan markers valid across the scheduler schema upgrade.
        if (kind !== 'adhan' || !marker.startsWith('riyadh:')) return false;
        const [, date, key] = marker.split(':');
        const wasPlayed = latest.has(`${date}:${key}`);
        if (wasPlayed) sessionMarkers.add(marker);
        return wasPlayed;
    }

    function persist(marker) {
        if (sessionMarkers.has(marker)) return false;
        sessionMarkers.add(marker);
        const latest = readMarkers(storage);
        if (latest.has(marker)) return false;
        latest.add(marker);
        try { storage?.setItem(STORAGE_KEY, JSON.stringify([...latest].slice(-600))); }
        catch { /* In-page and Web Lock dedupe remains active for this session. */ }
        return true;
    }

    async function dispatchOnce(event) {
        const marker = event.id;
        if (inFlight.has(marker)) return;
        inFlight.add(marker);
        const emit = async () => {
            if (destroyed || stored(marker, event.kind) || !persist(marker)) return;
            try { await onAlert(event); }
            catch { /* A playback/UI issue must not cause a duplicate prayer alert. */ }
        };
        try {
            if (locks?.request) {
                await locks.request(`aait-prayer-event-${marker}`, { ifAvailable: true }, lock => lock ? emit() : undefined);
            } else await emit();
        } catch { await emit(); }
        finally { inFlight.delete(marker); }
    }

    function markMissed(event) {
        persist(event.id);
    }

    function tick(time = now()) {
        if (destroyed || !isActive()) return;
        const currentDay = getRiyadhDate(time);
        if (day !== currentDay) {
            day = currentDay;
            payload = null;
            retryAt = 0;
            if (!getSnapshot) void load();
        }
        if (getSnapshot) {
            const snapshot = getSnapshot();
            payload = snapshot?.payload || null;
            payloadReadyAt = snapshot?.readyAt ?? Infinity;
        } else if (!loading && Date.now() >= retryAt) void load();
        if (!payload) return;
        const schedule = payload.days?.find(item => item.date === currentDay);
        if (!schedule) return;
        const currentTime = time.getTime();
        for (const event of getPrayerScheduleEvents(payload, currentDay, getIqamaSettings())) {
            const instant = event.timestamp;
            if (!Number.isFinite(instant) || stored(event.id, event.kind)) continue;
            if (instant <= Math.max(sessionStartedAt, suppressThrough) || instant < payloadReadyAt) {
                markMissed(event);
                continue;
            }
            if (currentTime < instant) continue;
            if (currentTime - instant > GRACE_PERIOD_MS) {
                markMissed(event);
                continue;
            }
            void dispatchOnce({ ...event, dueAt: instant, expiresAt: instant + 60000 });
        }
    }

    function skipMissed(time = now()) {
        suppressThrough = Math.max(suppressThrough, time.getTime());
        tick(time);
    }

    tick(now());
    return {
        tick,
        skipMissed,
        refresh: () => getSnapshot ? tick(now()) : load(true),
        destroy() { destroyed = true; }
    };
}

// Kept for callers using the original Riyadh-only API; the board uses createPrayerAlerts.
export const createRiyadhPrayerAlerts = createPrayerAlerts;
