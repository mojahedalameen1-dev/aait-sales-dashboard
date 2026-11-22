import { generateSpeechForDisplay, isValidSpeechRequest, isValidWav } from './audio-cache.js';
import { bearerToken, firebaseDatabaseReadWithEtag, firebaseDatabaseRequest, sendError, verifyDisplayToken } from './shared.js';
import { randomUUID } from 'node:crypto';

const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const MAX_GENERATION_ATTEMPTS = 2;
const CLAIM_LEASE_MS = 45000;

export function isActiveCallAudio(event, cacheKey, now = Date.now()) {
    return Boolean(event
        && ['pending', 'ready'].includes(event.audioStatus)
        && event.audioCacheKey === cacheKey
        && Number(event.expiresAt) > now);
}

/** Reserve one active synthesis at a time, with one bounded retry for a transient failure. */
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
        const time = now();
        const attempts = Number.isSafeInteger(item.generationAttempts) ? item.generationAttempts : 0;
        if (item.generationState === 'active' && item.generationLeaseUntil > time) {
            throw Object.assign(new Error('صوت النداء قيد التجهيز'), { statusCode: 425, retryAfterMs: Math.min(5000, item.generationLeaseUntil - time) });
        }
        if (['completed', 'failed'].includes(item.generationState) || (!item.generationState && item.generationAttempted) || attempts >= MAX_GENERATION_ATTEMPTS) {
            throw Object.assign(new Error('هذا النداء أُنجز أو استنفد محاولات توليد الصوت'), { statusCode: 409 });
        }
        if (item.generationRetryAt > time) {
            throw Object.assign(new Error('توليد هذا الصوت مؤجل مؤقتًا'), { statusCode: 503, retryAfterMs: item.generationRetryAt - time });
        }
        const claimId = randomUUID();
        try {
            await write(path, 'PUT', { ...item, generationAttempted: true, generationState: 'active', generationAttempts: attempts + 1,
                claimId, generationLeaseUntil: time + CLAIM_LEASE_MS, generationStartedAt: time }, { 'if-match': current.etag });
            return { ...item, claimId };
        } catch (error) { if (error.statusCode !== 412) throw error; }
    }
    throw Object.assign(new Error('طلب الصوت قيد المعالجة'), { statusCode: 425, retryAfterMs: 2000 });
}

export async function settleAudioRequest(eventId, claimId, error, {
    read = firebaseDatabaseReadWithEtag, write = firebaseDatabaseRequest, now = Date.now
} = {}) {
    const path = `calls/audioRequests/${eventId}`;
    const deferred = ['generation_in_progress', 'provider_cooldown'].includes(error?.code);
    const transient = error && (deferred || (!['invalid_input', 'invalid_audio', 'provider_error', 'not_configured'].includes(error.code)
        && (error.statusCode == null || error.statusCode === 429 || error.statusCode >= 500)));
    for (let attempt = 0; attempt < 4; attempt++) {
        const { data: item, etag } = await read(path);
        if (!item || item.claimId !== claimId || item.generationState !== 'active') return;
        const { claimId: _, generationLeaseUntil: __, ...metadata } = item;
        const attempts = Math.max(0, item.generationAttempts - (deferred ? 1 : 0));
        const generationState = !error ? 'completed' : transient && attempts < MAX_GENERATION_ATTEMPTS ? 'retry' : 'failed';
        const generationRetryAt = generationState === 'retry'
            ? now() + Math.max(2000, Number(error.retryAfterMs) || 0) : 0;
        try {
            await write(path, 'PUT', { ...metadata, generationState, generationAttempts: attempts, generationRetryAt }, { 'if-match': etag });
            return;
        } catch (failure) { if (failure.statusCode !== 412) throw failure; }
    }
    throw Object.assign(new Error('تعذر حفظ حالة صوت النداء'), { statusCode: 503 });
}

export function createAudioHandler({
    verify = verifyDisplayToken,
    readEvent = id => firebaseDatabaseRequest(`calls/public/${id}`),
    claimRequest = claimAudioRequest,
    settleRequest = settleAudioRequest,
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
            let audio;
            try {
                audio = await generate(descriptor);
                if (!isValidWav(audio)) throw Object.assign(new Error('عاد ملف صوت غير صالح'), { statusCode: 503, code: 'invalid_audio' });
            } catch (error) {
                if (descriptor.claimId) await settleRequest(eventId, descriptor.claimId, error);
                if (error.code === 'generation_in_progress') {
                    throw Object.assign(new Error('الصوت قيد التجهيز'), { statusCode: 425, retryAfterMs: 2000 });
                }
                if (!error.retryAfterMs && (error.statusCode >= 500 || !error.statusCode)) error.retryAfterMs = 2000;
                throw error;
            }
            if (descriptor.claimId) await settleRequest(eventId, descriptor.claimId);
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
