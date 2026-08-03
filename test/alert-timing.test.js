import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldTriggerAlert } from '../src/alert-timing.js';

test('30 minute alert catches up for ten minutes but never after meeting start', () => {
    assert.equal(shouldTriggerAlert(30 * 60, 30 * 60), true);
    assert.equal(shouldTriggerAlert(20 * 60, 30 * 60), true);
    assert.equal(shouldTriggerAlert(19 * 60 + 59, 30 * 60), false);
    assert.equal(shouldTriggerAlert(-1, 30 * 60), false);
});

test('5 minute alert survives a throttled tab waking shortly after start', () => {
    assert.equal(shouldTriggerAlert(5 * 60, 5 * 60), true);
    assert.equal(shouldTriggerAlert(0, 5 * 60), true);
    assert.equal(shouldTriggerAlert(-5 * 60, 5 * 60), true);
    assert.equal(shouldTriggerAlert(-5 * 60 - 1, 5 * 60), false);
});
