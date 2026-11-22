import test from 'node:test';
import assert from 'node:assert/strict';
import { MEETING_REMINDER_MINUTES, shouldTriggerAlert } from '../src/alert-timing.js';

test('only the five-minute meeting reminder is scheduled', () => {
    assert.deepEqual(MEETING_REMINDER_MINUTES, [5]);
    assert.equal(shouldTriggerAlert(30 * 60, 5 * 60), false);
    assert.equal(shouldTriggerAlert(29 * 60, 5 * 60), false);
});

test('5 minute alert survives a throttled tab waking shortly after start', () => {
    assert.equal(shouldTriggerAlert(5 * 60, 5 * 60), true);
    assert.equal(shouldTriggerAlert(0, 5 * 60), true);
    assert.equal(shouldTriggerAlert(-5 * 60, 5 * 60), true);
    assert.equal(shouldTriggerAlert(-5 * 60 - 1, 5 * 60), false);
});
