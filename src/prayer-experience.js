import { PRAYERS, getPrayerCity, getRiyadhDate, getNextPrayer, normalizePrayerTime } from './prayer-times.js';
import { getIqamaEvents } from './prayer-iqama.js';

export const PRAYER_FOCUS = Object.freeze({ approachingMs: 10 * 60000, adhanMs: 60000, withoutIqamaMs: 5 * 60000, iqamaMs: 60000 });

/** The card and its alerts use these exact same instants, city and verified iqama profile. */
export function getPrayerScheduleEvents(payload, date, iqamaSettings) {
    const city = getPrayerCity(payload?.city || 'riyadh');
    const schedule = payload?.days?.find(day => day.date === date);
    if (!city || !schedule) return [];
    const events = [];
    for (const prayer of PRAYERS) {
        const time = normalizePrayerTime(schedule.timings?.[prayer.key]);
        if (!time) continue;
        events.push({ key: prayer.key, label: prayer.label, time, kind: 'adhan' });
    }
    events.push(...getIqamaEvents(schedule, date, iqamaSettings, city.id));
    return events.map(event => ({
        ...event, date, city: city.label, cityId: city.id,
        id: `${city.id}:${date}:${event.key}:${event.kind}`,
        timestamp: Date.parse(`${date}T${event.time}:00+03:00`)
    })).filter(event => Number.isFinite(event.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
}

export function getPrayerPresentation(payload, time = new Date(), iqamaSettings) {
    const timestamp = new Date(time).getTime();
    const date = getRiyadhDate(timestamp);
    const events = getPrayerScheduleEvents(payload, date, iqamaSettings);
    const current = events.filter(event => event.kind === 'adhan' && event.timestamp <= timestamp).at(-1);
    const next = getNextPrayer(payload, timestamp + (current ? 1 : 0));
    if (current) {
        const iqama = events.find(event => event.key === current.key && event.kind === 'iqama');
        const elapsed = timestamp - current.timestamp;
        if (iqama && timestamp >= iqama.timestamp && timestamp < iqama.timestamp + PRAYER_FOCUS.iqamaMs) {
            return { phase: 'iqama', prayer: current, next, heading: 'حان وقت الإقامة', message: `حان موعد إقامة صلاة ${current.label}`, countdownMs: null, caption: 'حيّ على الصلاة', iqama };
        }
        if (elapsed < PRAYER_FOCUS.adhanMs) {
            return { phase: 'adhan', prayer: current, next, heading: 'حان وقت الصلاة', message: `حان وقت صلاة ${current.label}`, countdownMs: null, caption: 'دخل الوقت الآن' };
        }
        if (iqama && timestamp < iqama.timestamp) {
            return { phase: 'waiting-iqama', prayer: current, next, heading: 'المتبقي على الإقامة', countdownMs: iqama.timestamp - timestamp, caption: 'ساعة · دقيقة · ثانية', iqama };
        }
        if (!iqama && elapsed < PRAYER_FOCUS.withoutIqamaMs) {
            return { phase: 'adhan', prayer: current, next, heading: 'حان وقت الصلاة', message: `حان وقت صلاة ${current.label}`, countdownMs: null, caption: 'دخل الوقت · موعد الإقامة غير مضبوط' };
        }
    }
    const phase = next && next.remainingMs <= PRAYER_FOCUS.approachingMs ? 'approaching' : 'upcoming';
    return { phase, prayer: next, next: null, heading: phase === 'approaching' ? 'اقترب وقت الصلاة' : 'أقرب صلاة', countdownMs: next?.remainingMs ?? null, caption: 'ساعة · دقيقة · ثانية' };
}
