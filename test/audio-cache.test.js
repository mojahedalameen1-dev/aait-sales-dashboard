import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    createSpeechGenerator, createSpeechCacheKey, getSpeechSettings, isValidSpeechRequest,
    isValidWav, normalizeSpeechText, prepareSpeechRequest, synthesizeGroqSpeech, finalizeStreamingWav,
    getRateLimitCooldownMs
} from '../server/control/audio-cache.js';
import { claimAudioRequest, createAudioHandler, isActiveCallAudio } from '../server/control/audio.js';
import { createAckHandler } from '../server/control/ack.js';
import { parseEnvironment } from '../scripts/audio-env.js';

function wavFixture() {
    const wav = Buffer.alloc(52);
    wav.write('RIFF'); wav.writeUInt32LE(44, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8, 40);
    return wav;
}

function fakeLocks() {
    const held = new Map();
    return {
        async acquire(key, owner) { if (held.has(key)) return false; held.set(key, owner); return true; },
        async release(key, owner) { if (held.get(key) === owner) held.delete(key); },
        held
    };
}

function responseFixture() {
    return {
        headers: {}, statusCode: 0, body: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; }
    };
}

test('SHA-256 identity normalizes whitespace but preserves punctuation, diacritics and voice', () => {
    const a = getSpeechSettings({});
    assert.equal(normalizeSpeechText('  تنبيه\n إداري. '), 'تنبيه إداري.');
    assert.equal(createSpeechCacheKey('تنبيه\n إداري.', a), createSpeechCacheKey(' تنبيه إداري. ', a));
    assert.notEqual(createSpeechCacheKey('مُجَاهِد', a), createSpeechCacheKey('مجاهد', a));
    assert.notEqual(createSpeechCacheKey('تنبيه.', a), createSpeechCacheKey('تنبيه،', a));
    for (const voice of ['fahad', 'sultan']) assert.notEqual(createSpeechCacheKey('تنبيه.', a), createSpeechCacheKey('تنبيه.', getSpeechSettings({ GROQ_VOICE: voice })));
    assert.notEqual(createSpeechCacheKey('تنبيه.', a), createSpeechCacheKey('تنبيه.', getSpeechSettings({ GROQ_SPEECH_CONFIG_VERSION: 'v2' })));
});

test('private descriptors reject changed text/settings, unsupported voices and over-limit input', () => {
    const request = prepareSpeechRequest('تنبيه إداري.', getSpeechSettings({}));
    assert.equal(isValidSpeechRequest(request), true);
    assert.equal(isValidSpeechRequest({ ...request, text: 'نص آخر' }), false);
    assert.equal(isValidSpeechRequest({ ...request, settings: { ...request.settings, model: 'other' } }), false);
    assert.equal(isValidSpeechRequest({ ...request, settings: { ...request.settings, speed: 5 } }), false);
    assert.throws(() => getSpeechSettings({ GROQ_VOICE: 'invalid' }));
    assert.throws(() => prepareSpeechRequest('ا'.repeat(201)), error => error.code === 'invalid_input');
});

test('WAV validation rejects truncated, non-WAV, and oversized responses', () => {
    assert.equal(isValidWav(wavFixture()), true);
    assert.equal(isValidWav(wavFixture().subarray(0, 43)), false);
    assert.equal(isValidWav(Buffer.from('not a wave')), false);
    assert.equal(isValidWav(Buffer.alloc(4 * 1024 * 1024 + 1)), false);
});

test('streaming WAV length placeholders are finalized without accepting truncated declared data', () => {
    const raw = wavFixture(); raw.writeUInt32LE(0xffffffff, 4); raw.writeUInt32LE(0xffffffff, 40);
    assert.equal(isValidWav(raw), false);
    assert.equal(isValidWav(finalizeStreamingWav(raw)), true);
    const truncated = wavFixture(); truncated.writeUInt32LE(200, 40);
    assert.equal(isValidWav(finalizeStreamingWav(truncated)), false);
});

test('Groq request pins the server key, Saudi model, voice and WAV output without vocal tags', async () => {
    let captured;
    const audio = await synthesizeGroqSpeech('تنبيه إداري.', getSpeechSettings({}), {
        apiKey: 'unit-test-only', fetchImpl: async (url, options) => { captured = { url, options, body: JSON.parse(options.body) }; return new Response(wavFixture()); }
    });
    assert.equal(audio.equals(wavFixture()), true);
    assert.equal(captured.url, 'https://api.groq.com/openai/v1/audio/speech');
    assert.equal(captured.options.headers.Authorization, 'Bearer unit-test-only');
    assert.equal(captured.body.model, 'canopylabs/orpheus-arabic-saudi');
    assert.equal(captured.body.voice, 'abdullah'); assert.equal(captured.body.response_format, 'wav');
    assert.equal(captured.body.speed, 0.95); assert.doesNotMatch(captured.body.input, /\[[^\]]+\]/);
});

test('Groq 429 makes one request only and honors the provider quota reset', async () => {
    let calls = 0;
    await assert.rejects(() => synthesizeGroqSpeech('اختبار.', getSpeechSettings({}), {
        apiKey: 'unit-test-only', fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '9999' } }); }
    }), error => error.code === 'rate_limited' && error.retryAfterMs === 9999000);
    assert.equal(calls, 1);
});

test('Groq daily quota reset metadata is parsed and missing metadata pauses generation conservatively', () => {
    assert.equal(getRateLimitCooldownMs(new Headers({ 'x-ratelimit-reset-requests': '1d' })), 86400000);
    assert.equal(getRateLimitCooldownMs(new Headers({ 'retry-after': '120', 'x-ratelimit-reset-requests': '2m59s' })), 179000);
    assert.equal(getRateLimitCooldownMs(new Headers()), 86400000);
});

test('server lock rejects overlapping generation instead of spending twice', async () => {
    const locks = fakeLocks(); let providerCalls = 0; let release;
    const gate = new Promise(resolve => { release = resolve; });
    const generate = createSpeechGenerator({ locks, synthesize: async () => { providerCalls++; await gate; return wavFixture(); } });
    const request = prepareSpeechRequest('نداء متزامن.', getSpeechSettings({}));
    const first = generate(request);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(generate(request), error => error.statusCode === 409);
    release(); assert.equal((await first).equals(wavFixture()), true);
    assert.equal(providerCalls, 1); assert.equal(locks.held.size, 0);
});

test('cooldown blocks the provider and releases its lock', async () => {
    const locks = fakeLocks(); let providerCalls = 0;
    const generate = createSpeechGenerator({ locks, cooldown: { remainingMs: async () => 60000, set: async () => {} }, synthesize: async () => { providerCalls++; return wavFixture(); } });
    await assert.rejects(generate(prepareSpeechRequest('نداء.', getSpeechSettings({}))), error => error.code === 'provider_cooldown');
    assert.equal(providerCalls, 0); assert.equal(locks.held.size, 0);
});

test('provider failure persists cooldown without any automatic retry', async () => {
    let requests = 0; let cooldown = 0;
    const generate = createSpeechGenerator({ locks: fakeLocks(), cooldown: { remainingMs: async () => 0, set: async ms => { cooldown = ms; } }, synthesize: async () => { requests++; throw Object.assign(new Error('upstream'), { code: 'rate_limited', retryAfterMs: 60000 }); } });
    await assert.rejects(generate(prepareSpeechRequest('نداء.', getSpeechSettings({}))), error => error.statusCode === 503);
    assert.equal(requests, 1); assert.equal(cooldown, 60000);
});

test('audio access requires a live event with its exact key', () => {
    const key = 'a'.repeat(64); const event = { audioStatus: 'pending', audioCacheKey: key, expiresAt: 2000 };
    assert.equal(isActiveCallAudio(event, key, 1000), true);
    assert.equal(isActiveCallAudio(event, 'b'.repeat(64), 1000), false);
    assert.equal(isActiveCallAudio(event, key, 2000), false);
    assert.equal(isActiveCallAudio({ ...event, audioStatus: 'failed' }, key, 1000), false);
});

test('audio route refuses invalid credentials before reading data or generating', async () => {
    let calls = 0;
    const handler = createAudioHandler({ verify: async () => { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); }, readEvent: async () => { calls++; }, generate: async () => { calls++; } });
    const response = responseFixture(); await handler({ method: 'GET', headers: {} }, response);
    assert.equal(response.statusCode, 401); assert.equal(calls, 0);
});

test('untrusted display identities cannot forge an authoritative audio-started acknowledgement', async () => {
    const handler = createAckHandler({ verify: async () => { throw Object.assign(new Error('untrusted'), { statusCode: 403 }); } });
    const response = responseFixture();
    await handler({ method: 'POST', headers: {}, body: { eventId: 'test-event-id-123456', status: 'audio_started' } }, response);
    assert.equal(response.statusCode, 403);
});

test('expired events never generate; valid events return bounded private WAV bytes', async () => {
    const descriptor = prepareSpeechRequest('نداء.', getSpeechSettings({}));
    let claims = 0; let generates = 0; let expiresAt = Date.now() - 1;
    const handler = createAudioHandler({ verify: async () => ({}), readEvent: async () => ({ audioStatus: 'pending', audioCacheKey: descriptor.cacheKey, expiresAt }), claimRequest: async () => { claims++; return descriptor; }, generate: async () => { generates++; return wavFixture(); } });
    const request = { method: 'GET', headers: {}, query: { event: 'test-event-id-123456', key: descriptor.cacheKey } };
    const expired = responseFixture(); await handler(request, expired);
    assert.equal(expired.statusCode, 404); assert.equal(claims, 0); assert.equal(generates, 0);
    expiresAt = Date.now() + 60000; const valid = responseFixture(); await handler(request, valid);
    assert.equal(valid.statusCode, 200); assert.equal(valid.headers['Cache-Control'], 'private, no-store');
    assert.equal(valid.headers['Content-Type'], 'audio/wav'); assert.equal(valid.body.equals(wavFixture()), true);
    assert.equal(claims, 1); assert.equal(generates, 1);
});

test('concurrent requests consume only one generation claim per authorized event', async () => {
    let value = { ...prepareSpeechRequest('نداء.', getSpeechSettings({})), expiresAt: 5000, generationAttempted: false }; let version = 1;
    const options = {
        now: () => 1000, read: async () => ({ data: structuredClone(value), etag: String(version) }),
        write: async (_path, method, next, headers) => { assert.equal(method, 'PUT'); if (headers['if-match'] !== String(version)) throw Object.assign(new Error('race'), { statusCode: 412 }); value = next; version++; }
    };
    const key = value.cacheKey;
    const results = await Promise.allSettled([claimAudioRequest('test-event-id-123456', key, options), claimAudioRequest('test-event-id-123456', key, options)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(value.generationAttempted, true);
    await assert.rejects(claimAudioRequest('test-event-id-123456', key, options), error => error.statusCode === 409);
});

test('RTDB rules expose display events but keep synthesis metadata and permissions private', async () => {
    const { rules } = JSON.parse(await readFile(new URL('../database.rules.json', import.meta.url), 'utf8'));
    assert.equal(rules['.read'], false); assert.equal(rules['.write'], false);
    assert.match(rules.calls.public['.read'], /anonymous/); assert.equal(rules.calls.public['.write'], false);
    assert.match(rules.preview.calls.public['.read'], /anonymous/); assert.equal(rules.preview.calls.public['.write'], false);
    assert.equal(rules.preview['.read'] ?? rules['.read'], false);
    assert.equal(rules.calls.audioRequests?.['.read'] ?? rules['.read'], false);
});

test('secret parser supports Windows BOM and quoting without printing values', () => {
    const parsed = parseEnvironment('\uFEFFGROQ_API_KEY=unit-test-only\r\nGROQ_VOICE="fahad"\r\n# ignored\r\n');
    assert.equal(parsed.get('GROQ_API_KEY'), 'unit-test-only'); assert.equal(parsed.get('GROQ_VOICE'), 'fahad'); assert.equal(parsed.size, 2);
});
