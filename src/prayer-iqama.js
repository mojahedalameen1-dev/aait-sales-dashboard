import { PRAYERS, isPrayerDate, normalizePrayerTime } from './prayer-times.js';

const MAX_VERIFICATION_AGE_DAYS = 366;
const MAX_INTERVAL_MINUTES = 120;
export const IQAMA_PRESET_VERSION = 'owner-2026-10-27-v1';

/** Explicit manual intervals approved by the owner, not an official mosque timetable. */
export function resolveIqamaSettings(value) {
    const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (saved.presetVersion === IQAMA_PRESET_VERSION) return saved;
    return {
        ...saved,
        presetVersion: IQAMA_PRESET_VERSION,
        regular: {
            city: 'riyadh', enabled: true, confirmed: true,
            source: 'مدد إقامة يدوية أكدها مالك اللوحة', verifiedAt: '2026-10-27',
            intervals: { Fajr: 20, Dhuhr: 15, Asr: 15, Maghrib: 10, Isha: 15 }
        }
    };
}

function isFreshVerification(date, today) {
    if (!isPrayerDate(date) || !isPrayerDate(today) || date > today) return false;
    const age = (Date.parse(`${today}T12:00:00+03:00`) - Date.parse(`${date}T12:00:00+03:00`)) / 86400000;
    return Number.isFinite(age) && age <= MAX_VERIFICATION_AGE_DAYS;
}

function normalizeIntervals(value) {
    if (!value || typeof value !== 'object') return null;
    const intervals = {};
    for (const prayer of PRAYERS) {
        const minutes = Number(value[prayer.key]);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) return null;
        intervals[prayer.key] = minutes;
    }
    return intervals;
}

export function validateIqamaProfile(profile, name, today) {
    if (!profile || profile.enabled !== true || profile.confirmed !== true) return { valid: false, profile: null, reason: 'confirmation_required' };
    const source = typeof profile.source === 'string' ? profile.source.trim().slice(0, 240) : '';
    const verifiedAt = typeof profile.verifiedAt === 'string' ? profile.verifiedAt : '';
    const intervals = normalizeIntervals(profile.intervals);
    if (source.length < 3) return { valid: false, profile: null, reason: 'source_required' };
    if (!isFreshVerification(verifiedAt, today)) return { valid: false, profile: null, reason: 'verification_date_invalid' };
    if (!intervals) return { valid: false, profile: null, reason: 'intervals_invalid' };

    if (name === 'ramadan') {
        const { startDate, endDate } = profile;
        if (!isPrayerDate(startDate) || !isPrayerDate(endDate) || startDate > endDate) return { valid: false, profile: null, reason: 'ramadan_range_invalid' };
        const rangeDays = (Date.parse(`${endDate}T12:00:00+03:00`) - Date.parse(`${startDate}T12:00:00+03:00`)) / 86400000;
        if (rangeDays > 36) return { valid: false, profile: null, reason: 'ramadan_range_invalid' };
    }
    return { valid: true, profile: { source, verifiedAt, intervals, name, city: profile.city || 'riyadh', startDate: profile.startDate, endDate: profile.endDate } };
}

/** Only returns a profile after explicit confirmation and a recently dated source. */
export function getVerifiedIqamaProfile(settings, today) {
    if (!settings) return null;
    const ramadan = settings.ramadan;
    if (ramadan?.enabled === true) {
        if (!isPrayerDate(ramadan.startDate) || !isPrayerDate(ramadan.endDate) || ramadan.startDate > ramadan.endDate) return null;
        if (today >= ramadan.startDate && today <= ramadan.endDate) return validateIqamaProfile(ramadan, 'ramadan', today).profile;
    }
    return validateIqamaProfile(settings.regular, 'regular', today).profile;
}

export function getIqamaEvents(schedule, date, settings, city = 'riyadh') {
    const profile = getVerifiedIqamaProfile(settings, date);
    if (!profile || profile.city !== city || !schedule || schedule.date !== date) return [];
    // Noon in Riyadh is always the same UTC calendar date, independent of the TV's local zone.
    const weekday = new Date(`${date}T12:00:00+03:00`).getUTCDay();
    const events = [];
    for (const prayer of PRAYERS) {
        // Jumu'ah is not Dhuhr iqama; no inferred Friday schedule is ever used.
        if (prayer.key === 'Dhuhr' && weekday === 5) continue;
        const adhan = normalizePrayerTime(schedule.timings?.[prayer.key]);
        if (!adhan) continue;
        const instant = Date.parse(`${date}T${adhan}:00+03:00`) + profile.intervals[prayer.key] * 60000;
        const riyadhTime = new Date(instant + 3 * 60 * 60 * 1000);
        if (!Number.isFinite(instant) || riyadhTime.toISOString().slice(0, 10) !== date) continue;
        const hours = riyadhTime.toISOString().slice(11, 13);
        const minutes = riyadhTime.toISOString().slice(14, 16);
        events.push({ key: prayer.key, label: prayer.label, time: `${hours}:${minutes}`, kind: 'iqama', verifiedSource: profile.source, verifiedAt: profile.verifiedAt });
    }
    return events;
}

export const IQAMA_LIMITS = Object.freeze({ maxIntervalMinutes: MAX_INTERVAL_MINUTES, maxVerificationAgeDays: MAX_VERIFICATION_AGE_DAYS });
