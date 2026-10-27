import { createHash } from 'node:crypto';
import { getPrayerSpeechText } from '../../src/prayer-audio-assets.js';
import { PRAYERS, getRiyadhDate, addPrayerDays } from '../../src/prayer-times.js';
import { prepareSpeechRequest, getSpeechSettings, generateSpeechForDisplay, isValidWav } from './audio-cache.js';
import { bearerToken, verifyDisplayToken, firebaseDatabaseReadWithEtag, firebaseDatabaseRequest, getFirebaseClientConfig, sendError } from './shared.js';

export function getPrayerAudioManifest(env = process.env) {
    try {
        const settings = getSpeechSettings(env);
        return { voice: settings.voice, assets: Object.fromEntries(PRAYERS.map(({ key }) => [key, Object.fromEntries(['adhan', 'iqama'].map(kind => [kind, { cacheKey: prepareSpeechRequest(getPrayerSpeechText(key, kind), settings).cacheKey }]))])) };
    } catch { return null; }
}

/** Private quota metadata only. WAVs stay in the display's persistent IndexedDB cache. */
export async function claimPrayerAudio(uid, cacheKey, { read = firebaseDatabaseReadWithEtag, write = firebaseDatabaseRequest, now = Date.now } = {}) {
    const instant = now();
    const date = getRiyadhDate(instant);
    const owner = createHash('sha256').update(uid).digest('hex');
    const path = `controlPrayerAudioRequests/${date}/${cacheKey}`;
    const current = await read(path);
    const attempts = Array.isArray(current.data?.attempts) ? current.data.attempts.slice(0, 3) : [];
    const previous = attempts.findLast(item => item.owner === owner);
    const retryAfterMs = attempts.length >= 3
        ? Date.parse(`${addPrayerDays(date)}T00:00:00+03:00`) - instant
        : previous && instant - previous.at < 5 * 60000 ? previous.at + 5 * 60000 - instant : 0;
    if (retryAfterMs > 0) throw Object.assign(new Error('بلغ طلب الصوت حده المؤقت؛ سيُستخدم الصوت المحفوظ إن توفر'), { statusCode: 429, retryAfterMs });
    try {
        await write(path, 'PUT', { attempts: [...attempts, { owner, at: instant }] }, { 'if-match': current.etag });
    } catch (error) {
        if (error.statusCode === 412) throw Object.assign(new Error('الصوت قيد التجهيز؛ لم يُرسل طلب توليد مكرر'), { statusCode: 409 });
        throw error;
    }
}

export function createPrayerAudioHandler({ verify = verifyDisplayToken, claim = claimPrayerAudio, generate = generateSpeechForDisplay, configured = () => getFirebaseClientConfig().speechConfigured, settings = getSpeechSettings } = {}) {
    return async function handler(request, response) {
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            return response.status(405).json({ error: 'Method not allowed' });
        }
        try {
            const token = bearerToken(request);
            if (!token) return response.status(401).json({ error: 'يلزم اتصال شاشة العرض لتشغيل صوت الصلاة' });
            const claims = await verify(token);
            const params = new URL(request.url || '/', 'https://aait.invalid').searchParams;
            const key = request.query?.key || params.get('key');
            const kind = request.query?.kind || params.get('kind');
            const text = typeof key === 'string' && typeof kind === 'string' ? getPrayerSpeechText(key, kind) : null;
            if (!text) return response.status(400).json({ error: 'طلب تذكير الصلاة غير صالح' });
            const descriptor = prepareSpeechRequest(text, settings());
            const requestedCacheKey = request.query?.cache || params.get('cache');
            if (requestedCacheKey !== descriptor.cacheKey) return response.status(409).json({ error: 'تغير إعداد الصوت؛ أعد تحميل شاشة العرض' });
            if (!configured()) throw Object.assign(new Error('محرك صوت الصلاة غير مهيأ على الخادم'), { statusCode: 503 });
            await claim(claims.uid || claims.sub, descriptor.cacheKey);
            const audio = await generate(descriptor);
            if (!isValidWav(audio)) throw Object.assign(new Error('عاد ملف صوت الصلاة غير صالح'), { statusCode: 503 });
            response.setHeader('Content-Type', 'audio/wav');
            response.setHeader('Content-Length', String(audio.length));
            response.setHeader('X-Audio-Cache-Key', descriptor.cacheKey);
            return response.status(200).send(audio);
        } catch (error) {
            if (error.retryAfterMs) response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
            return sendError(response, error, 'تعذر تجهيز صوت الصلاة؛ يظل التذكير المرئي متاحًا');
        }
    };
}

export default createPrayerAudioHandler();
