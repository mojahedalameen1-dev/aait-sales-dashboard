import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPriorityQueue } from '../src/audio-priority.js';

test('prayer audio runs before queued administrator announcements without overlap', async () => {
    const queue = createAudioPriorityQueue();
    const order = [];
    let releaseCurrent;
    const current = queue.enqueue('admin', async () => {
        order.push('admin-active');
        await new Promise(resolve => { releaseCurrent = resolve; });
        order.push('admin-finished');
        return { started: true };
    });
    await Promise.resolve();
    const nextAdmin = queue.enqueue('admin', async () => { order.push('admin-next'); return { started: true }; });
    const prayer = queue.enqueue('prayer', async () => { order.push('prayer'); return { started: true }; });
    releaseCurrent();
    await Promise.all([current, prayer, nextAdmin]);
    assert.deepEqual(order, ['admin-active', 'admin-finished', 'prayer', 'admin-next']);
});

test('expired queued audio is discarded without invoking playback', async () => {
    const queue = createAudioPriorityQueue();
    let release;
    const current = queue.enqueue('admin', () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    let started = false;
    const expired = queue.enqueue('prayer', () => { started = true; return { started: true }; }, { expiresAt: Date.now() - 1 });
    release({ started: true });
    await Promise.all([current, expired]);
    assert.equal(started, false);
    assert.equal((await expired).reason, 'expired');
});

test('ISO expiry is honored and lower priority work remains queued', async () => {
    const queue = createAudioPriorityQueue();
    const result = await queue.enqueue('admin', () => ({ started: true }), { expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(result, { started: false, reason: 'expired' });
});
