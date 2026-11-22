import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { AUDIO_STATE, createAudioDelivery } from '../src/audio-delivery.js';
import { createPrayerAlerts, PRAYER_ALERT_GRACE_MS } from '../src/prayer-alerts.js';

function memory() {
    const records = new Map();
    return { getItem: key => records.get(key) || null, setItem: (key, value) => records.set(key, value) };
}

function media() {
    const calls = [];
    let blocked = false;
    let count = 0;
    class Player extends EventTarget {
        constructor() { super(); count++; }
        getAttribute() { return this.src; }
        pause() {}
        play() {
            calls.push(this.src.startsWith('data:') ? 'activation' : this.src.startsWith('blob:') ? 'speech' : this.src);
            return blocked ? Promise.reject(new DOMException('requires interaction', 'NotAllowedError')) : Promise.resolve();
        }
        playing() { this.dispatchEvent(new Event('playing')); }
        ended() { this.dispatchEvent(new Event('ended')); }
        finish() { this.playing(); this.ended(); }
    }
    const fixture = { calls, createPlayer: () => (fixture.player = new Player()),
        block(value) { blocked = value; }, count: () => count };
    return fixture;
}

test('a later NotAllowedError holds the unplayed job until a gesture; accepted play is not completion', async () => {
    const m = media();
    const store = memory();
    const trace = [];
    const engine = createAudioDelivery({ createPlayer: m.createPlayer, storage: () => store, onDiagnostic: (kind, details) => trace.push([kind, details]) });
    try {
        m.block(true);
        assert.equal(await engine.unlock(), false);
        m.block(false);
        assert.equal(await engine.unlock({ userGesture: true }), true);
        m.block(true);
        const pending = engine.enqueue('routine', { id: 'test-reminder', clipUrl: '/sounds/a5.mp3', repetitions: 1, expiresAt: Date.now() + 20000 });
        await settle();
        assert.equal(engine.state, AUDIO_STATE.LOCKED);
        assert.equal(engine.queuedCount, 1);
        engine.kick(); engine.kick();
        assert.deepEqual(m.calls, ['activation', 'activation', '/sounds/a5.mp3']);

        m.block(false);
        assert.equal(await engine.unlock({ userGesture: true }), true);
        await settle();
        assert.equal(engine.getProgress('test-reminder'), null);
        m.player.playing();
        assert.equal(engine.getProgress('test-reminder'), null);
        m.player.ended();
        assert.equal((await pending).completedRepetitions, 1);
        assert.equal(engine.getProgress('test-reminder').completed, 1);
        assert.equal(m.count(), 1);
        assert.ok(trace.some(([kind, detail]) => kind === 'play_rejected' && detail.errorName === 'NotAllowedError'));
        assert.ok(trace.some(([kind, detail]) => kind === 'ended' && detail.audibility === 'unverified'));
    } finally { engine.stop(); }
});

test('freeze/resume during repeat two keeps the completed repeat and cached recording; another tab does not replay', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const m = media();
    const store = memory();
    const options = { createPlayer: m.createPlayer, storage: () => store, onDiagnostic: () => {} };
    const engine = createAudioDelivery(options);
    const sibling = createAudioDelivery({ ...options, canOwnAudio: () => siblingOwns });
    let siblingOwns = false;
    t.after(() => { engine.stop(); sibling.stop(); });
    const request = { id: 'admin:repeat', expiresAt: Date.now() + 90000, loadRecording: () => {
        loadCount++;
        return new Blob(['safe test']);
    } };
    let loadCount = 0;
    await engine.unlock();
    const pending = engine.enqueue('admin', request);
    const other = sibling.enqueue('admin', request);
    await settle();
    m.player.finish(); await settle(); // beep 1
    m.player.finish(); await settle(); // speech 1
    assert.equal(engine.getProgress(request.id).completed, 1);
    t.mock.timers.tick(3000);
    await settle();
    m.player.finish(); await settle(); // beep 2
    m.player.playing();
    engine.suspend();
    await settle();
    assert.equal(engine.queuedCount, 1);
    assert.equal(engine.getProgress(request.id).completed, 1);
    engine.wake();
    await settle();
    m.player.finish();
    assert.equal((await pending).completedRepetitions, 2);
    assert.deepEqual(m.calls, ['activation', '/sounds/beeb.mp3', 'speech', '/sounds/beeb.mp3', 'speech', 'speech']);
    assert.equal(loadCount, 1);
    siblingOwns = true;
    await sibling.unlock();
    assert.equal((await other).alreadyCompleted, true);
    assert.equal(loadCount, 1);
});

test('an expired autoplay wait is dropped, and quota Retry-After prevents early synthesis attempts', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const m = media();
    const engine = createAudioDelivery({ createPlayer: m.createPlayer, onDiagnostic: () => {} });
    t.after(() => engine.stop());
    const expired = engine.enqueue('routine', { clipUrl: '/sounds/m5.mp3', expiresAt: Date.now() + 2000, repetitions: 1 });
    t.mock.timers.tick(2001);
    assert.equal((await expired).reason, 'expired');
    assert.deepEqual(m.calls, []);
    await engine.unlock();
    let requests = 0;
    const quota = engine.enqueue('prayer', {
        expiresAt: Date.now() + 5000,
        loadRecording() { requests++; throw Object.assign(new Error('quota'), { status: 429, retryAt: Date.now() + 30000 }); }
    });
    await settle();
    t.mock.timers.tick(5001);
    assert.equal((await quota).reason, 'expired');
    assert.equal(requests, 1);
});

test('a hidden display detects due prayer after 5, 15 and 30 elapsed minutes; a frozen display recovers only in time', async () => {
    const day = '2026-11-21';
    const date = new Date(day + 'T14:50:00+03:00');
    const getSnapshot = () => ({ payload: { city: 'riyadh', days: [{ date: day, timings: {
        Fajr: '05:00', Dhuhr: '11:40', Asr: '14:50', Maghrib: '17:10', Isha: '18:40'
    } }] } });
    for (const minutes of [5, 15, 30]) {
        let time = new Date(date.getTime() - minutes * 60000);
        let alerts = 0;
        const scheduler = createPrayerAlerts({ storage: memory(), now: () => time, getSnapshot, locks: null,
            onAlert: () => { alerts++; return { completedRepetitions: 2 }; } });
        scheduler.tick(time = new Date(date.getTime() + 60000)); // deadline discovered late from wall time
        await settle();
        assert.equal(alerts, 1);
        scheduler.destroy();
    }
    let time = new Date(date.getTime() - 1000);
    const expired = createPrayerAlerts({ storage: memory(), now: () => time, getSnapshot, locks: null,
        onAlert: () => assert.fail('must not play after deadline') });
    expired.resume(time = new Date(date.getTime() + PRAYER_ALERT_GRACE_MS + 1));
    await settle();
    expired.destroy();
});
