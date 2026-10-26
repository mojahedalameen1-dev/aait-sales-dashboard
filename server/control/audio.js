import { generateSpeechForDisplay, isValidSpeechRequest, isValidWav } from './audio-cache.js';
import { bearerToken, firebaseDatabaseReadWithEtag, firebaseDatabaseRequest, sendError, verifyDisplayToken } from './shared.js';

const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export function isActiveCallAudio(event, cacheKey, now = Date.now()) {
    return Boolean(event
        && ['pending', 'ready'].includes(event.audioStatus)
        && event.audioCacheKey === cacheKey
        && Number(event.expiresAt) > now);
}

/** Small private metadata only: one provider attempt per authorized event, never WAV bytes. */
export async function claimAudioRequest(eventId, cacheKey, {
    read = firebaseDatabaseReadWithEtag,
    write = firebaseDatabaseRequest,
    now = Date.now
} = {}) {
    const path = `calls/audioRequests/${eventId}`;
    for (let attempt = 0; attempt < 4; attempt++) {
        const current = await read(path);
        const item = current.data;
        if (!isValidSpeechRequest(item) || item.cacheKey !== cacheKey || Number(item.expiresAt) <= now()) {
            throw Object.assign(new Error('انتهت صلاحية طلب الصوت أو لم يعد متاحًا'), { statusCode: 404 });
        }
        if (item.generationAttempted) {
            throw Object.assign(new Error('سبق طلب توليد هذا النداء؛ لن يتكرر استهلاك الخدمة'), { statusCode: 409 });
        }
        try {
            await write(path, 'PUT', { ...item, generationAttempted: true, generationStartedAt: now() }, { 'if-match': current.etag });
            return item;
        } catch (error) { if (error.statusCode !== 412) throw error; }
    }
    throw Object.assign(new Error('طلب الصوت قيد المعالجة'), { statusCode: 409 });
}

export function createAudioHandler({
    verify = verifyDisplayToken,
    readEvent = id => firebaseDatabaseRequest(`calls/public/${id}`),
    claimRequest = claimAudioRequest,
    generate = generateSpeechForDisplay
} = {}) {
    return async function handler(request, response) {
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            return response.status(405).json({ error: 'Method not allowed' });
        }
        try {
            await verify(bearerToken(request));
            const params = new URL(request.url || '/', 'https://aait.invalid').searchParams;
            const cacheKey = request.query?.key || params.get('key');
            const eventId = request.query?.event || params.get('event');
            if (typeof cacheKey !== 'string' || typeof eventId !== 'string'
                || !CACHE_KEY_PATTERN.test(cacheKey) || !EVENT_ID_PATTERN.test(eventId)) {
                return response.status(400).json({ error: 'طلب ملف الصوت غير صالح' });
            }
            if (!isActiveCallAudio(await readEvent(eventId), cacheKey)) return response.status(404).json({ error: 'ملف الصوت غير متوفر' });
            const descriptor = await claimRequest(eventId, cacheKey);
            const audio = await generate(descriptor);
            if (!isValidWav(audio)) throw Object.assign(new Error('عاد ملف صوت غير صالح'), { statusCode: 503 });
            response.setHeader('Content-Type', 'audio/wav');
            response.setHeader('Content-Length', String(audio.length));
            response.setHeader('Content-Disposition', 'inline; filename="announcement.wav"');
            return response.status(200).send(audio);
        } catch (error) {
            if (error.retryAfterMs) response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
            return sendError(response, error, 'تعذر تجهيز ملف الصوت');
        }
    };
}

export default createAudioHandler();
