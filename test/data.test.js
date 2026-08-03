import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatTodayDate,
    getMeetingTimingState,
    normalizeDate,
    parseCSV,
    parseTimeStr
} from '../src/data.js';

test('CSV parser preserves quoted commas and multiline content', () => {
    const rows = parseCSV('date,project\n"2026/08/03","Client, Project"\n"2026/08/04","Line 1\nLine 2"');
    assert.equal(rows[1][1], 'Client, Project');
    assert.equal(rows[2][1], 'Line 1 Line 2');
});

test('date normalization uses the regional day/month/year order', () => {
    assert.equal(normalizeDate('3/8/2026'), '2026/08/03');
    assert.equal(normalizeDate('2026-08-03'), '2026/08/03');
});

test('time parsing follows the sheet convention while preserving explicit morning times', () => {
    assert.equal(parseTimeStr('8:00'), '20:00');
    assert.equal(parseTimeStr('08:00'), '08:00');
    assert.equal(parseTimeStr('8:00 ص'), '08:00');
    assert.equal(parseTimeStr('8:00 م'), '20:00');
    assert.equal(parseTimeStr('12:00 ص'), '00:00');
});

test('meeting state uses one consistent 60 minute duration', () => {
    const now = new Date('2026-08-03T09:30:00Z'); // 12:30 Riyadh
    const date = formatTodayDate(now);
    assert.equal(getMeetingTimingState({ date, time: '13:00', status: '' }, now).state, 'upcoming');
    assert.equal(getMeetingTimingState({ date, time: '12:00', status: '' }, now).state, 'running');
    assert.equal(getMeetingTimingState({ date, time: '11:00', status: '' }, now).state, 'overdue');
});
