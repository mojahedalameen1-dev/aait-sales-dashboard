import test from 'node:test';
import assert from 'node:assert/strict';

test('admin and prayer use the same cached beeb/speech sequence without duplicating generation', async () => {
    const names = ['Audio', 'localStorage', 'navigator', 'setTimeout'];
    const original = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const nativeTimeout = globalThis.setTimeout;
    const trace = [];
    let beepPlayers = 0;
    let beepLoads = 0;
    let beepPlays = 0;
    let speechPlays = 0;

    class FakeAudio extends EventTarget {
        constructor(src = '') {
            super();
            this.src = src;
            this.paused = true;
            if (src === '/sounds/beeb.mp3') beepPlayers++;
        }
        load() { if (this.src === '/sounds/beeb.mp3') beepLoads++; }
        pause() { this.paused = true; }
        play() {
            this.paused = false;
            const kind = this.src === '/sounds/beeb.mp3' ? 'beeb' : this.src.startsWith('blob:') ? 'speech' : 'unlock';
            if (kind === 'beeb') beepPlays++;
            if (kind === 'speech') speechPlays++;
            nativeTimeout(() => {
                if (this.paused || kind === 'unlock') return;
                trace.push(`${kind}-started`);
                this.dispatchEvent(new Event('playing'));
            }, 0);
            nativeTimeout(() => {
                if (this.paused || kind === 'unlock') return;
                trace.push(`${kind}-ended`);
                this.dispatchEvent(new Event('ended'));
            }, 3);
            return Promise.resolve();
        }
    }

    const values = new Map();
    const overrides = {
        Audio: FakeAudio,
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
        navigator: { locks: { request: async (_name, _options, callback) => callback(null) } },
        setTimeout: (callback, ms, ...args) => {
            if (ms === 3000) {
                trace.push('silence-3000-start');
                return nativeTimeout(() => { trace.push('silence-3000-end'); callback(); }, 1, ...args);
            }
            return nativeTimeout(callback, ms, ...args);
        }
    };
    for (const [name, value] of Object.entries(overrides)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    let notifications;
    try {
        notifications = await import('../src/notifications.js');
        assert.equal(await notifications.unlockAudio(), true);
        const recording = new Blob(['same cached speech'], { type: 'audio/wav' });
        const started = [];
        let completed = 0;
        const office = await notifications.playAnnouncementAudio(recording, {
            onStarted: ({ repetition, total }) => started.push(`admin-${repetition}/${total}`),
            onCompleted: () => { completed++; }
        });
        let prayerLoads = 0;
        const prayer = await notifications.playPrayerAnnouncement(async () => { prayerLoads++; return recording; }, {
            onStarted: ({ repetition, total }) => started.push(`prayer-${repetition}/${total}`),
            onCompleted: () => { completed++; }
        });

        assert.deepEqual(trace, [
            'beeb-started', 'beeb-ended', 'speech-started', 'speech-ended', 'silence-3000-start', 'silence-3000-end',
            'beeb-started', 'beeb-ended', 'speech-started', 'speech-ended',
            'beeb-started', 'beeb-ended', 'speech-started', 'speech-ended', 'silence-3000-start', 'silence-3000-end',
            'beeb-started', 'beeb-ended', 'speech-started', 'speech-ended'
        ]);
        assert.deepEqual(started, ['admin-1/2', 'admin-2/2', 'prayer-1/2', 'prayer-2/2']);
        assert.equal(office.completedRepetitions, 2);
        assert.equal(prayer.completedRepetitions, 2);
        assert.equal(completed, 2);
        assert.equal(prayerLoads, 1);
        assert.equal(beepPlayers, 1);
        assert.equal(beepLoads, 1);
        assert.equal(beepPlays, 4);
        assert.equal(speechPlays, 4);

        const interrupted = await notifications.playAnnouncementAudio(recording, {
            onStarted: ({ repetition }) => { if (repetition === 1) notifications.stopAudioPlayback(); }
        });
        assert.equal(interrupted.completedRepetitions, 0);
        assert.equal(interrupted.reason, 'interrupted');
        assert.equal(beepPlays, 5);
        assert.equal(speechPlays, 5);
    } finally {
        notifications?.stopAudioPlayback();
        for (const name of names) {
            if (original[name]) Object.defineProperty(globalThis, name, original[name]);
            else delete globalThis[name];
        }
    }
});
