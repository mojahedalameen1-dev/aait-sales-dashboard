import { createHash, randomUUID } from 'node:crypto';
import {
    firebaseDatabaseReadWithEtag,
    firebaseDatabaseRequest
} from './shared.js';

export const GROQ_TTS_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
export const GROQ_TTS_MODEL = 'canopylabs/orpheus-arabic-saudi';
export const SUPPORTED_GROQ_VOICES = Object.freeze(['fahad', 'sultan', 'abdullah']);
export const SPEECH_MAX_CHARS = 200;
export const SPEECH_CONFIG_VERSION = 'aait-ar-sa-v1';
export const MAX_WAV_BYTES = 4 * 1024 * 1024;
const LOCK_TTL_MS = 45000;
const LOCK_PATH = 'controlAudioLocks';
const COOLDOWN_PATH = 'controlAudioState/groqCooldown';

export function normalizeSpeechText(value) {
    return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function getSpeechSettings(env = process.env) {
    const voice = env.GROQ_VOICE?.trim() || 'abdullah';
    if (!SUPPORTED_GROQ_VOICES.includes(voice)) throw new Error('Unsupported Groq voice');
    const version = env.GROQ_SPEECH_CONFIG_VERSION?.trim() || SPEECH_CONFIG_VERSION;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) throw new Error('Unsupported speech configuration version');
    return {
        model: GROQ_TTS_MODEL,
        voice,
        speed: 0.95,
        sampleRate: 24000,
        version
    };
}

export function createSpeechCacheKey(text, settings = getSpeechSettings()) {
    const normalized = normalizeSpeechText(text);
    return createHash('sha256').update(JSON.stringify({
        text: normalized,
        model: settings.model,
        voice: settings.voice,
        speed: settings.speed,
        sampleRate: settings.sampleRate,
        version: settings.version
    })).digest('hex');
}

export function prepareSpeechRequest(text, settings = getSpeechSettings()) {
    const normalized = normalizeSpeechText(text);
    if (!normalized || Array.from(normalized).length > SPEECH_MAX_CHARS) {
        throw Object.assign(new Error('Speech input exceeds the model limit'), { code: 'invalid_input', statusCode: 400 });
    }
    return { text: normalized, settings, cacheKey: createSpeechCacheKey(normalized, settings) };
}

export function isValidSpeechRequest(request) {
    try {
        if (!request || !/^[a-f0-9]{64}$/.test(request.cacheKey || '')) return false;
        const settings = getSpeechSettings({ GROQ_VOICE: request.settings?.voice, GROQ_SPEECH_CONFIG_VERSION: request.settings?.version });
        if (Object.keys(settings).some(key => settings[key] !== request.settings?.[key])) return false;
        return prepareSpeechRequest(request.text, settings).cacheKey === request.cacheKey;
    } catch { return false; }
}

async function readAudioResponse(response) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_WAV_BYTES) {
        throw Object.assign(new Error('Speech provider returned an oversized WAV'), { code: 'invalid_audio' });
    }
    if (!response.body?.getReader) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_WAV_BYTES) throw Object.assign(new Error('Speech provider returned an oversized WAV'), { code: 'invalid_audio' });
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_WAV_BYTES) {
                await reader.cancel().catch(() => {});
                throw Object.assign(new Error('Speech provider returned an oversized WAV'), { code: 'invalid_audio' });
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

export function isValidWav(value, maxBytes = MAX_WAV_BYTES) {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) return false;
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length < 44 || bytes.length > maxBytes
        || bytes.toString('ascii', 0, 4) !== 'RIFF'
        || bytes.toString('ascii', 8, 12) !== 'WAVE') return false;
    const declaredLength = bytes.readUInt32LE(4) + 8;
    if (declaredLength > bytes.length || declaredLength < 44) return false;
    let offset = 12;
    let validFormat = false;
    let validData = false;
    while (offset + 8 <= declaredLength) {
        const chunkName = bytes.toString('ascii', offset, offset + 4);
        const chunkLength = bytes.readUInt32LE(offset + 4);
        const contentStart = offset + 8;
        const contentEnd = contentStart + chunkLength;
        if (contentEnd > declaredLength) return false;
        if (chunkName === 'fmt ' && chunkLength >= 16) {
            const format = bytes.readUInt16LE(contentStart);
            const channels = bytes.readUInt16LE(contentStart + 2);
            const sampleRate = bytes.readUInt32LE(contentStart + 4);
            const bitsPerSample = bytes.readUInt16LE(contentStart + 14);
            validFormat = [1, 3].includes(format) && channels >= 1 && channels <= 2
                && sampleRate >= 8000 && sampleRate <= 96000
                && [8, 16, 24, 32].includes(bitsPerSample);
        }
        if (chunkName === 'data' && chunkLength > 0) validData = true;
        offset = contentEnd + (chunkLength % 2);
    }
    return validFormat && validData;
}

/** Streaming PCM encoders may use 0xffffffff lengths; finalize only these known placeholders. */
export function finalizeStreamingWav(value) {
    const bytes = Buffer.from(value);
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return bytes;
    const unknownRiffLength = bytes.readUInt32LE(4) === 0xffffffff;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const size = bytes.readUInt32LE(offset + 4);
        if (bytes.toString('ascii', offset, offset + 4) === 'data' && size === 0xffffffff) {
            bytes.writeUInt32LE(bytes.length - offset - 8, offset + 4);
            break;
        }
        if (offset + 8 + size > bytes.length) return bytes;
        offset += 8 + size + size % 2;
    }
    if (unknownRiffLength) bytes.writeUInt32LE(bytes.length - 8, 4);
    return bytes;
}

function parseRetryAfterMs(value, now = Date.now()) {
    const input = String(value ?? '').trim();
    if (!input) return 0;
    const seconds = Number(input);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(input);
    if (Number.isFinite(date)) return Math.max(0, date - now);

    // Groq reset headers use compact values such as "2m59.56s".
    const parts = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)];
    if (!parts.length || parts.map(part => part[0]).join('') !== input) return 0;
    const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return parts.reduce((total, part) => total + Number(part[1]) * factors[part[2].toLowerCase()], 0);
}

export function getRateLimitCooldownMs(headers, now = Date.now()) {
    const retryAfter = parseRetryAfterMs(headers?.get?.('retry-after'), now);
    const requestReset = parseRetryAfterMs(headers?.get?.('x-ratelimit-reset-requests'), now);
    const reset = Math.max(retryAfter, requestReset);
    // Never probe the provider repeatedly when it omits reset metadata.
    return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(30_000, reset || 24 * 60 * 60 * 1000));
}

export async function synthesizeGroqSpeech(text, settings = getSpeechSettings(), {
    apiKey = process.env.GROQ_API_KEY?.trim(),
    fetchImpl = globalThis.fetch,
    onRawAudio
} = {}) {
    if (!apiKey) throw Object.assign(new Error('Speech provider is not configured'), { code: 'not_configured' });
    const input = normalizeSpeechText(text);
    if (!input || Array.from(input).length > SPEECH_MAX_CHARS) {
        throw Object.assign(new Error('Speech input exceeds the model limit'), { code: 'invalid_input' });
    }
    const response = await fetchImpl(GROQ_TTS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: settings.model,
            voice: settings.voice,
            input,
            response_format: 'wav',
            sample_rate: settings.sampleRate,
            speed: settings.speed
        }),
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
        const retryAfterMs = response.status === 429
            ? getRateLimitCooldownMs(response.headers)
            : response.status >= 500 ? 15000 : 0;
        throw Object.assign(new Error('Speech provider request failed'), {
            code: response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'upstream_error' : 'provider_error',
            providerStatus: response.status,
            retryAfterMs
        });
    }
    const rawAudio = await readAudioResponse(response);
    await onRawAudio?.(rawAudio);
    const audio = finalizeStreamingWav(rawAudio);
    if (!isValidWav(audio)) throw Object.assign(new Error('Speech provider returned invalid WAV audio'), { code: 'invalid_audio' });
    return audio;
}

function createFirebaseLockStore({ now = Date.now } = {}) {
    return {
        async acquire(cacheKey, owner) {
            const path = `${LOCK_PATH}/${cacheKey}`;
            for (let attempt = 0; attempt < 4; attempt++) {
                const current = await firebaseDatabaseReadWithEtag(path);
                if (Number(current.data?.expiresAt) > now()) return false;
                try {
                    await firebaseDatabaseRequest(path, 'PUT', { owner, expiresAt: now() + LOCK_TTL_MS }, { 'if-match': current.etag });
                    return true;
                } catch (error) {
                    if (error.statusCode !== 412) throw error;
                }
            }
            return false;
        },
        async isHeld(cacheKey) {
            const current = await firebaseDatabaseRequest(`${LOCK_PATH}/${cacheKey}`);
            return Number(current?.expiresAt) > now();
        },
        async release(cacheKey, owner) {
            const path = `${LOCK_PATH}/${cacheKey}`;
            try {
                const current = await firebaseDatabaseReadWithEtag(path);
                if (current.data?.owner === owner) {
                    await firebaseDatabaseRequest(path, 'DELETE', undefined, { 'if-match': current.etag });
                }
            } catch { /* Expired or superseded locks are safe to leave for their bounded TTL. */ }
        }
    };
}

function createFirebaseCooldownStore({ now = Date.now } = {}) {
    return {
        async remainingMs() {
            const state = await firebaseDatabaseRequest(COOLDOWN_PATH);
            return Math.max(0, Number(state?.until) - now());
        },
        async set(retryAfterMs, reason) {
            if (!retryAfterMs) return;
            for (let attempt = 0; attempt < 4; attempt++) {
                const current = await firebaseDatabaseReadWithEtag(COOLDOWN_PATH);
                const until = Math.max(Number(current.data?.until) || 0, now() + retryAfterMs);
                try {
                    await firebaseDatabaseRequest(COOLDOWN_PATH, 'PUT', { until, reason }, { 'if-match': current.etag });
                    return;
                } catch (error) {
                    if (error.statusCode !== 412) throw error;
                }
            }
        }
    };
}

/** The server returns bytes only; persistent WAV caching belongs to the display's IndexedDB. */
export function createSpeechGenerator({
    locks,
    cooldown = { remainingMs: async () => 0, set: async () => {} },
    synthesize = synthesizeGroqSpeech
}) {
    return async function generate(request) {
        if (!isValidSpeechRequest(request)) throw Object.assign(new Error('طلب توليد الصوت غير صالح'), { statusCode: 400, code: 'invalid_input' });
        const owner = randomUUID();
        if (!await locks.acquire(request.cacheKey, owner)) {
            throw Object.assign(new Error('الصوت قيد التجهيز على شاشة أخرى؛ لم يتكرر طلب الخدمة'), { statusCode: 409, code: 'generation_in_progress' });
        }
        try {
            const remainingMs = await cooldown.remainingMs();
            if (remainingMs > 0) throw Object.assign(new Error('خدمة الصوت في فترة تهدئة مؤقتة'), { statusCode: 503, code: 'provider_cooldown', retryAfterMs: remainingMs });
            const audio = await synthesize(request.text, request.settings);
            if (!isValidWav(audio)) throw Object.assign(new Error('عاد ملف صوت غير صالح'), { code: 'invalid_audio' });
            return audio;
        } catch (error) {
            if (error.retryAfterMs > 0 && error.code !== 'provider_cooldown') {
                await cooldown.set(error.retryAfterMs, error.code === 'rate_limited' ? 'rate_limited' : 'upstream_error').catch(() => {});
            }
            throw Object.assign(new Error('تعذّر تجهيز الصوت؛ يبقى النداء المرئي متاحًا'), {
                statusCode: error.statusCode || 503, code: error.code || 'audio_unavailable', retryAfterMs: error.retryAfterMs || 0
            });
        } finally {
            await locks.release(request.cacheKey, owner).catch(() => {});
        }
    };
}

export const generateSpeechForDisplay = createSpeechGenerator({
    locks: createFirebaseLockStore(),
    cooldown: createFirebaseCooldownStore()
});
