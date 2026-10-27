const KEYS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const PRAYER_NAMES = Object.freeze({ Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء' });

export const PRAYER_AUDIO_ASSETS = Object.freeze(Object.fromEntries(KEYS.map(key => {
    const slug = key.toLowerCase();
    return [key, Object.freeze({
        adhan: `/sounds/prayer/v1/adhan-${slug}.wav`,
        iqama: `/sounds/prayer/v1/iqama-${slug}.wav`
    })];
})));

export const PRAYER_SPEECH_TEXT = Object.freeze(Object.fromEntries(KEYS.map(key => {
    const name = PRAYER_NAMES[key];
    return [key, Object.freeze({
        adhan: `حان الآن موعد صلاة ${name}.`,
        iqama: `حان الآن موعد إقامة صلاة ${name}.`
    })];
})));

export function getPrayerSpeechText(key, kind) {
    if (!KEYS.includes(key) || !['adhan', 'iqama'].includes(kind)) return null;
    return PRAYER_SPEECH_TEXT[key]?.[kind] || null;
}

export async function isWavBlob(blob) {
    if (!(blob instanceof Blob) || blob.size < 44 || blob.size > 4 * 1024 * 1024 || !blob.type.toLowerCase().includes('wav')) return false;
    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
        if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') return false;
        const riffEnd = view.getUint32(4, true) + 8;
        if (riffEnd < 44 || riffEnd > bytes.length) return false;
        let offset = 12; let validFormat = false; let validData = false;
        while (offset + 8 <= riffEnd) {
            const chunk = ascii(offset, offset + 4);
            const size = view.getUint32(offset + 4, true);
            const content = offset + 8;
            const end = content + size;
            if (end > riffEnd) return false;
            if (chunk === 'fmt ' && size >= 16) {
                const format = view.getUint16(content, true);
                const channels = view.getUint16(content + 2, true);
                const sampleRate = view.getUint32(content + 4, true);
                const bits = view.getUint16(content + 14, true);
                validFormat = [1, 3].includes(format) && channels >= 1 && channels <= 2
                    && sampleRate >= 8000 && sampleRate <= 96000 && [8, 16, 24, 32].includes(bits);
            }
            if (chunk === 'data' && size > 0) validData = true;
            offset = end + size % 2;
        }
        return validFormat && validData;
    } catch { return false; }
}

/** Loads only same-origin, build-time WAV assets. This module never calls speech APIs. */
export function createPrayerAudioAssetLoader({ fetchImpl = globalThis.fetch, baseUrl = '' } = {}) {
    return async ({ key, kind }) => {
        const path = PRAYER_AUDIO_ASSETS[key]?.[kind];
        if (!path || typeof fetchImpl !== 'function') return null;
        try {
            const signal = typeof globalThis.AbortSignal?.timeout === 'function' ? globalThis.AbortSignal.timeout(5000) : undefined;
            const response = await fetchImpl(`${baseUrl}${path}`, { cache: 'force-cache', credentials: 'same-origin', signal });
            if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('wav')) return null;
            const blob = await response.blob();
            return await isWavBlob(blob) ? blob : null;
        } catch { return null; }
    };
}

export function createPrayerAudioSequence({ playBeep, playSpeech, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), canContinue = () => true }) {
    return async (blob, { gapMs = 1400 } = {}) => {
        const expected = 2; // Each prayer reminder is confirmed exactly twice, never an unbounded retry.
        if (!canContinue()) return { started: false, reason: 'expired', repetitions: 0 };
        const beep = await playBeep();
        if (!blob) {
            let tones = beep?.started === true ? 1 : 0;
            if (tones && canContinue()) {
                await wait(gapMs);
                if (canContinue() && (await playBeep())?.started) tones++;
            }
            return { started: tones > 0, speechAvailable: false, reason: 'speech_asset_missing', repetitions: tones, expectedRepetitions: expected };
        }
        let completed = 0;
        let started = 0;
        let result;
        for (let repetition = 1; repetition <= expected; repetition++) {
            if (repetition > 1) await wait(gapMs);
            if (!canContinue()) return { started: started > 0, reason: 'expired', repetitions: started, completedRepetitions: completed, speechAvailable: true };
            result = await playSpeech(blob, { repetition, total: expected });
            if (result?.started) started++;
            if (result?.started && !result.reason) completed++;
            if (!result?.started || result.reason) break;
        }
        return { ...result, started: started > 0, toneStarted: beep?.started === true, speechAvailable: true, repetitions: started, completedRepetitions: completed, expectedRepetitions: expected };
    };
}
