import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime12h } from '../src/data.js';
import { meetingDisplayState, meetingMode, sortMeetingsForGrid } from '../control/meeting-grid.js';

const now = new Date('2026-10-24T12:30:00+03:00');
const today = '2026/10/24';

function meeting(id, time, overrides = {}) {
    return { id, date: today, time, project: `اجتماع ${id}`, team: 'م. مجاهد', via: 'عن بعد', status: 'قائم', ...overrides };
}

test('grid keeps every today state and orders running, upcoming by time, done, cancelled last', () => {
    const source = [
        meeting('cancelled', '10:00', { status: 'لم يتم' }),
        meeting('upcoming-late', '14:00'),
        meeting('done-explicit', '15:00', { status: 'تم' }),
        meeting('running-later', '12:10'),
        meeting('upcoming-early', '13:00'),
        meeting('running-earlier', '12:00'),
        meeting('other-day', '12:00', { date: '2026/10/25' })
    ];

    const result = sortMeetingsForGrid(source, now);
    assert.deepEqual(result.map(item => item.id), [
        'running-earlier', 'running-later', 'upcoming-early', 'upcoming-late', 'done-explicit', 'cancelled'
    ]);
    assert.deepEqual(result.map(item => item.state), [
        'running', 'running', 'upcoming', 'upcoming', 'done', 'cancelled'
    ]);
});

test('ended-by-time meetings are moved to done without changing the existing duration rule', () => {
    const result = meetingDisplayState(meeting('overdue', '11:00'), now);
    assert.equal(result, 'done');
});

test('meeting type uses sheet modality or a known meeting link, never invents an in-person location', () => {
    assert.equal(meetingMode(meeting('online', '13:00', { via: 'عن بُعد' })), 'online');
    assert.equal(meetingMode(meeting('in-person', '13:00', { via: 'حضوري' })), 'in_person');
    assert.equal(meetingMode(meeting('unknown', '13:00', { via: 'تطبيق' })), '');
    assert.equal(meeting('missing-location', '13:00', { via: 'حضوري' }).location, undefined);
});

test('control time labels reuse the dashboard 12-hour Arabic suffix format with English digits', () => {
    assert.equal(formatTime12h('09:30'), '9:30 ص');
    assert.equal(formatTime12h('13:15'), '1:15 م');
    assert.equal(formatTime12h('00:05'), '12:05 ص');
});
