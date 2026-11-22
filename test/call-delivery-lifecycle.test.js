import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createAckHandler } from '../server/control/ack.js';

const id = 'isolated-call-12345';

test('ack transitions remain ordered even when an older writer hits a realtime database conflict', async () => {
    let data = { id, expiresAt: Date.now() + 60000, status: 'sent', audioCacheKey: 'a'.repeat(64) };
    let rev = 1;
    let conflict = true;
    const handler = createAckHandler({
        verify() {},
        async read() { return { data, etag: String(rev) }; },
        async write(path, method, payload, headers) {
            assert.equal(path, 'calls/public/' + id);
            assert.equal(method, 'PUT');
            assert.equal(headers['If-Match'], String(rev++));
            if (conflict) {
                conflict = false;
                data = { ...data, status: 'displayed' };
                throw Object.assign(new Error('concurrent write'), { statusCode: 412 });
            }
            data = payload;
        }
    });
    const post = async status => {
        const response = { status(code) { this.code = code; return this; }, json(result) { return result; } };
        return handler({ method: 'POST', headers: {}, body: { eventId: id, status } }, response);
    };
    assert.equal((await post('audio_started')).status, 'audio_started');
    assert.equal((await post('audio_completed')).status, 'audio_completed');
    assert.equal((await post('audio_failed')).status, 'audio_completed');
    assert.equal((await post('displayed')).status, 'audio_completed');
    assert.equal(data.audioCacheKey, 'a'.repeat(64));
});

test('isolated Firebase stream retains a locked call, starts it once, and reconnects without replaying cached speech', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const values = new Map();
    const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key) };
    storage.setItem('aait_board_anonymous_auth_v1', JSON.stringify({ idToken: 'mock-local', expiresAt: Date.now() + 180000 }));
    const config = { firebaseConfigured: true, firebase: { databaseUrl: 'https://db.example.invalid', apiKey: 'local-fixture' } };
    const event = { id, createdAt: Date.now(), expiresAt: Date.now() + 240000, audioStatus: 'pending',
        callType: 'office', employeeName: 'Fixture', audioCacheKey: 'a'.repeat(64) };
    const streams = [], acks = [];
    const mediaLog = [];
    let player;
    class AudioFixture extends EventTarget {
        constructor() { super(); player = this; }
        getAttribute() { return this.src; }
        pause() {}
        async play() {
            mediaLog.push(this.src);
            return undefined;
        }
        finish() {
            this.dispatchEvent(new Event('playing'));
            this.dispatchEvent(new Event('ended'));
        }
    }
    const element = () => ({ classList: { add() {}, remove() {} }, append() {}, setAttribute() {}, remove() {} });
    const globals = {
        localStorage: storage,
        document: { createElement: element, body: { append() {} }, visibilityState: 'hidden' },
        window: { addEventListener() {}, location: { origin: 'http://localhost' } },
        Audio: AudioFixture
    };
    const previous = Object.fromEntries(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
        for (const [name, descriptor] of Object.entries(previous)) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        if (url === '/api/control/config') return Response.json(config);
        if (url === '/api/control/ack') {
            acks.push(JSON.parse(options.body).status);
            return Response.json({ ok: true });
        }
        assert.match(String(url), /^https:\/\/db\.example\.invalid\//);
        return new Response(new ReadableStream({ start: controller => streams.push(controller) }), {
            headers: { 'Content-Type': 'text/event-stream' }
        });
    });
    const [receiverModule, notifications] = await Promise.all([
        import('../src/call-receiver.js'), import('../src/notifications.js')
    ]);
    let reads = 0;
    const receiver = receiverModule.createCallReceiver({
        storage,
        audioCache: { getOrCreate: async () => { reads++; return { blob: new Blob(['cached fake recording']) }; } }
    });
    try {
        const broadcast = () => streams.at(-1).enqueue(new TextEncoder().encode(
            'event: put\ndata: ' + JSON.stringify({ path: '/', data: { [id]: event } }) + '\n\n'));
        await settle();
        broadcast();
        await settle();
        assert.deepEqual(acks, ['displayed']);
        assert.equal(reads, 0, 'do not load/generate in a locked background tab');
        assert.equal(storage.getItem('aait_board_processed_calls_v1'), null);
        await notifications.unlockAudio({ userGesture: true });
        await settle();
        player.finish(); await settle(); // beep 1
        player.finish(); await settle(); // speech 1
        assert.deepEqual(acks, ['displayed', 'audio_started']);
        assert.equal(storage.getItem('aait_board_processed_calls_v1'), null);
        t.mock.timers.tick(3000);
        await settle();
        player.finish(); await settle(); // beep 2
        player.finish(); await settle(); // speech 2
        assert.deepEqual(acks, ['displayed', 'audio_started', 'audio_completed']);
        assert.deepEqual(JSON.parse(storage.getItem('aait_board_processed_calls_v1')), [id]);
        receiver.suspend();
        await settle();
        receiver.resume();
        await settle();
        assert.equal(streams.length, 2);
        broadcast();
        await settle();
        assert.equal(reads, 1);
        assert.equal(mediaLog.filter(src => src.startsWith('blob:')).length, 2);
    } finally {
        receiver.destroy();
        notifications.stopAudioPlayback();
        await settle();
    }
});

test('meeting catch-up stays silent at 30 minutes and plays only the five-minute asset once for simultaneous calls', async t => {
    const day = '2026/11/21';
    const start = Date.parse('2026-11-21T16:00:00+03:00');
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start - 30 * 60000 });
    const values = new Map(), clips = [];
    const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
    let player;
    class AudioFixture extends EventTarget {
        constructor() { super(); player = this; }
        pause() {}
        async play() { if (this.src.startsWith('/sounds/')) clips.push(this.src); }
        finish() {
            this.dispatchEvent(new Event('playing'));
            this.dispatchEvent(new Event('ended'));
        }
    }
    const globals = { localStorage: storage, document: { getElementById: () => null, visibilityState: 'hidden' }, Audio: AudioFixture };
    const previous = Object.fromEntries(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    const live = await import('../src/notifications.js?meeting-lifecycle-test');
    try {
        const meetings = ['fixture-a', 'fixture-b'].map(id => ({ id, date: day, time: '16:00', team: 'أشرف', status: '' }));
        await live.unlockAudio({ userGesture: true });
        live.checkMeetingTimers(meetings, day);
        await settle();
        assert.deepEqual(clips, []);
        assert.equal(values.has('aait_delivered_notifications'), false);
        t.mock.timers.tick(60000);
        live.checkMeetingTimers(meetings, day);
        await settle();
        assert.deepEqual(clips, []);
        t.mock.timers.tick(25 * 60000);
        live.checkMeetingTimers(meetings, day);
        await settle();
        assert.deepEqual(clips, ['/sounds/a5.mp3']);
        player.finish();
        await settle();
        live.checkMeetingTimers(meetings, day);
        await settle();
        assert.deepEqual(clips, ['/sounds/a5.mp3']);
        assert.deepEqual(JSON.parse(values.get('aait_delivered_notifications')).keys.sort(),
            ['fixture-a_5min', 'fixture-b_5min']);
    } finally {
        live.stopAudioPlayback();
        for (const [name, descriptor] of Object.entries(previous)) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});
