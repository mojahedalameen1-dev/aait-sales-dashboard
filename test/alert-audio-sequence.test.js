import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_AUDIO_REPEAT_SILENCE_MS, createAlertAudioSequence } from '../src/alert-audio-sequence.js';

const speech = new Blob(['one cached speech recording'], { type: 'audio/wav' });

test('runs beeb → speech → 3 seconds silence → beeb → same speech, waiting for real media completion', async () => {
    const stages = [];
    const waitDurations = [];
    const run = createAlertAudioSequence({
        playBeep: async ({ repetition }) => {
            stages.push(`beeb-${repetition}-started`);
            await Promise.resolve();
            stages.push(`beeb-${repetition}-ended`);
            return { started: true, completed: true };
        },
        playSpeech: async (blob, { repetition, total }) => {
            assert.equal(blob, speech);
            assert.equal(total, 2);
            stages.push(`speech-${repetition}-started`);
            await Promise.resolve(); // Represents waiting for the audio element's ended event.
            stages.push(`speech-${repetition}-ended`);
            return { started: true, completed: true };
        },
        wait: async milliseconds => {
            waitDurations.push(milliseconds);
            stages.push('silence-start');
            await Promise.resolve();
            stages.push('silence-end');
        }
    });

    const result = await run(speech);
    assert.deepEqual(stages, [
        'beeb-1-started', 'beeb-1-ended', 'speech-1-started', 'speech-1-ended',
        'silence-start', 'silence-end', 'beeb-2-started', 'beeb-2-ended',
        'speech-2-started', 'speech-2-ended'
    ]);
    assert.deepEqual(waitDurations, [ALERT_AUDIO_REPEAT_SILENCE_MS]);
    assert.equal(result.repetitions, 2);
    assert.equal(result.completedRepetitions, 2);
    assert.equal(result.expectedRepetitions, 2);
});

test('does not start speech if beeb failed or was not played through to its end', async () => {
    for (const failure of [
        { started: false, completed: false, reason: 'beep_playback_failed' },
        { started: true, completed: false, reason: 'interrupted' }
    ]) {
        let speechStarts = 0;
        const result = await createAlertAudioSequence({
            playBeep: async () => failure,
            playSpeech: async () => { speechStarts++; return { started: true, completed: true }; }
        })(speech);
        assert.equal(speechStarts, 0);
        assert.equal(result.reason, failure.reason);
        assert.equal(result.completedRepetitions, 0);
    }
});

test('waits exactly 3000ms after the first speech ends and cancels stale second playback', async () => {
    const stages = [];
    let relevant = true;
    const result = await createAlertAudioSequence({
        playBeep: async ({ repetition }) => { stages.push(`beeb-${repetition}`); return { started: true, completed: true }; },
        playSpeech: async (_blob, { repetition }) => { stages.push(`speech-${repetition}`); return { started: true, completed: true }; },
        wait: async ms => { assert.equal(ms, 3000); stages.push(`silence-${ms}`); relevant = false; },
        canContinue: () => relevant
    })(speech);
    assert.deepEqual(stages, ['beeb-1', 'speech-1', 'silence-3000']);
    assert.equal(result.started, true);
    assert.equal(result.completedRepetitions, 1);
    assert.equal(result.reason, 'expired');
});

test('does not play a beep by itself when the cached speech recording is unavailable', async () => {
    let beeps = 0;
    const result = await createAlertAudioSequence({
        playBeep: async () => { beeps++; return { started: true, completed: true }; },
        playSpeech: async () => assert.fail('speech must be present before the sequence begins')
    })(null);
    assert.equal(beeps, 0);
    assert.equal(result.reason, 'speech_unavailable');
});
