import test from 'node:test';
import assert from 'node:assert/strict';

test('the real priority playback path plays prayer speech twice, loads it once, and releases the queue on mute', async () => {
    const names = ['Audio', 'AudioContext', 'localStorage', 'navigator', 'setTimeout'];
    const original = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const nativeTimeout = globalThis.setTimeout;
    let plays = 0;
    class FakeAudio extends EventTarget {
        constructor(src = '') { super(); this.src = src; }
        load() {}
        pause() { this.paused = true; }
        play() {
            this.paused = false;
            if (this.src.startsWith('blob:')) {
                plays++;
                nativeTimeout(() => { if (!this.paused) this.dispatchEvent(new Event('playing')); }, 0);
                nativeTimeout(() => { if (!this.paused) this.dispatchEvent(new Event('ended')); }, 3);
            }
            return Promise.resolve();
        }
    }
    const param = () => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    class FakeAudioContext {
        currentTime = 0;
        async resume() {}
        async close() { this.state = 'closed'; }
        createGain() { return { gain: param(), connect() {} }; }
        createOscillator() { return { frequency: param(), connect() {}, start() {}, stop() {} }; }
    }
    const values = new Map();
    const overrides = {
        Audio: FakeAudio, AudioContext: FakeAudioContext,
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
        navigator: { locks: { request: async (_name, _options, callback) => callback(null) } },
        setTimeout: (callback, ms, ...args) => nativeTimeout(callback, ms === 1450 || ms === 1400 ? 1 : ms, ...args)
    };
    for (const [name, value] of Object.entries(overrides)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    let notifications;
    try {
        notifications = await import('../src/notifications.js');
        assert.equal(await notifications.unlockAudio(), true);
        let loads = 0;
        const repetitions = [];
        const result = await notifications.playPrayerAnnouncement(async () => { loads++; return new Blob(['isolated playback fixture']); }, {
            onStarted: ({ repetition }) => repetitions.push(repetition)
        });
        assert.equal(loads, 1); assert.equal(plays, 2);
        assert.deepEqual(repetitions, [1, 2]); assert.equal(result.repetitions, 2);
        const muted = await notifications.playPrayerAnnouncement(new Blob(['isolated fixture']), {
            onStarted: () => notifications.stopAudioPlayback()
        });
        assert.equal(muted.repetitions, 1); assert.equal(muted.reason, 'interrupted');
        assert.equal(plays, 3);
        await notifications.unlockAudio();
        const afterMute = await notifications.playPrayerAnnouncement(new Blob(['isolated fixture']));
        assert.equal(afterMute.repetitions, 2); assert.equal(plays, 5);
    } finally {
        notifications?.stopAudioPlayback();
        for (const name of names) {
            if (original[name]) Object.defineProperty(globalThis, name, original[name]);
            else delete globalThis[name];
        }
    }
});
