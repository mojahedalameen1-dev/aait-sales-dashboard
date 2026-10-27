import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrayerAudioAssetLoader, createPrayerAudioSequence, getPrayerSpeechText, isWavBlob, PRAYER_AUDIO_ASSETS } from '../src/prayer-audio-assets.js';

const wavBytes = new Uint8Array(46);
wavBytes.set(new TextEncoder().encode('RIFF'), 0);
wavBytes.set(new TextEncoder().encode('WAVE'), 8);
wavBytes.set(new TextEncoder().encode('fmt '), 12);
wavBytes.set(new TextEncoder().encode('data'), 36);
const wavView = new DataView(wavBytes.buffer);
wavView.setUint32(4, 38, true);
wavView.setUint32(16, 16, true);
wavView.setUint16(20, 1, true);
wavView.setUint16(22, 1, true);
wavView.setUint32(24, 24000, true);
wavView.setUint32(28, 48000, true);
wavView.setUint16(32, 2, true);
wavView.setUint16(34, 16, true);
wavView.setUint32(40, 2, true);
const wav = new Blob([wavBytes], { type: 'audio/wav' });

test('manifest defines two fixed same-origin WAV assets for each of five prayers', () => {
    const paths = Object.values(PRAYER_AUDIO_ASSETS).flatMap(item => Object.values(item));
    assert.equal(paths.length, 10);
    assert.equal(new Set(paths).size, 10);
    for (const path of paths) assert.match(path, /^\/sounds\/prayer\/v\d+\/(adhan|iqama)-[a-z]+\.wav$/);
    assert.equal(paths.filter(path => path.startsWith('https://')).length, 0);
});

test('the ten Arabic phrases are unique, concise and cover adhan plus iqama for each prayer', () => {
    const phrases = Object.keys(PRAYER_AUDIO_ASSETS).flatMap(key => ['adhan', 'iqama'].map(kind => getPrayerSpeechText(key, kind)));
    assert.equal(phrases.length, 10);
    assert.equal(new Set(phrases).size, 10);
    assert.ok(phrases.every(text => Array.from(text).length <= 200));
    assert.equal(getPrayerSpeechText('Fajr', 'adhan'), 'حان الآن وقت أذان صلاة الفجر.');
    assert.equal(getPrayerSpeechText('Isha', 'iqama'), 'حان الآن موعد إقامة صلاة العشاء.');
    assert.equal(getPrayerSpeechText('Friday', 'iqama'), null);
});

test('static prayer asset loader validates WAV and never requests a speech endpoint', async () => {
    const requested = [];
    const load = createPrayerAudioAssetLoader({ fetchImpl: async (url, options) => {
        requested.push({ url, options });
        return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    } });
    const result = await load({ key: 'Fajr', kind: 'adhan' });
    assert.equal(await isWavBlob(result), true);
    assert.deepEqual(requested.map(item => item.url), ['/sounds/prayer/v1/adhan-fajr.wav']);
    assert.equal(requested[0].options.credentials, 'same-origin');
    assert.equal(await load({ key: 'Fajr', kind: 'other' }), null);
});

test('bad or missing static audio is rejected without external fallback', async () => {
    let calls = 0;
    const load = createPrayerAudioAssetLoader({ fetchImpl: async () => {
        calls++;
        return new Response('not audio', { headers: { 'Content-Type': 'text/html' } });
    } });
    assert.equal(await load({ key: 'Isha', kind: 'iqama' }), null);
    assert.equal(calls, 1);
    assert.equal(await isWavBlob(new Blob(['not wav'], { type: 'audio/wav' })), false);
});

test('short tone completes before the speech asset starts', async () => {
    const order = [];
    const sequence = createPrayerAudioSequence({
        playBeep: async () => { order.push('beep-start'); await Promise.resolve(); order.push('beep-end'); return { started: true }; },
        playSpeech: async () => { order.push('speech-start'); return { started: true }; }
    });
    const result = await sequence(wav);
    assert.deepEqual(order, ['beep-start', 'beep-end', 'speech-start']);
    assert.equal(result.started, true);
    assert.equal(result.toneStarted, true);
});

test('missing speech keeps only the short chime and reports unavailable speech', async () => {
    const result = await createPrayerAudioSequence({
        playBeep: async () => ({ started: true }),
        playSpeech: async () => assert.fail('missing audio must not call speech playback')
    })(null);
    assert.deepEqual(result, { started: true, speechAvailable: false, reason: 'speech_asset_missing' });
});
