import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallRequest, syncMeetingFieldState } from '../control/call-form-state.js';

function fields() {
    const attributes = new Map();
    return {
        section: { hidden: false },
        grid: {
            inert: false,
            setAttribute: (key, value) => attributes.set(key, value),
            getAttribute: key => attributes.get(key)
        }
    };
}

test('office calls inert the hidden meeting grid for every role', () => {
    for (const canCallMeeting of [false, true]) {
        const { section, grid } = fields();
        syncMeetingFieldState(section, grid, { callType: 'office', canCallMeeting });
        assert.equal(section.hidden, true);
        assert.equal(grid.inert, true);
        assert.equal(grid.getAttribute('aria-disabled'), 'true');
        assert.equal(grid.getAttribute('aria-busy'), 'false');
    }
});

test('authorized meeting grid is announced busy and inert only while loading', () => {
    const { section, grid } = fields();
    syncMeetingFieldState(section, grid, { callType: 'meeting', canCallMeeting: true, loading: true });
    assert.equal(section.hidden, false);
    assert.equal(grid.inert, true);
    assert.equal(grid.getAttribute('aria-disabled'), 'true');
    assert.equal(grid.getAttribute('aria-busy'), 'true');
    syncMeetingFieldState(section, grid, { callType: 'meeting', canCallMeeting: true, loading: false });
    assert.equal(section.hidden, false);
    assert.equal(grid.inert, false);
    assert.equal(grid.getAttribute('aria-disabled'), 'false');
    assert.equal(grid.getAttribute('aria-busy'), 'false');
});

test('finishing a meeting fetch cannot enable the hidden grid after switching to an office call', () => {
    const { section, grid } = fields();
    syncMeetingFieldState(section, grid, { callType: 'meeting', canCallMeeting: true, loading: true });
    syncMeetingFieldState(section, grid, { callType: 'office', canCallMeeting: true, loading: true });
    syncMeetingFieldState(section, grid, { callType: 'office', canCallMeeting: true, loading: false });
    assert.equal(section.hidden, true);
    assert.equal(grid.inert, true);
    assert.equal(grid.getAttribute('aria-disabled'), 'true');
});

test('admins without meeting access cannot activate the meeting selection grid', () => {
    const { section, grid } = fields();
    assert.equal(syncMeetingFieldState(section, grid, { callType: 'meeting', canCallMeeting: false }), false);
    assert.equal(section.hidden, true);
    assert.equal(grid.inert, true);
    assert.equal(grid.getAttribute('aria-disabled'), 'true');
});

test('office call requests never include stale meeting selection or details', () => {
    assert.deepEqual(createCallRequest({
        callId: 'call-1', employeeId: 'mojahed', callType: 'office', meeting: { id: 'previous-meeting' },
        meetingOwner: 'stale', meetingLocation: 'stale', meetingMode: 'in_person', confirmedEndedMeeting: true
    }), { callId: 'call-1', employeeId: 'mojahed', callType: 'office' });
});

test('meeting request includes source ID and only the selected admin-supplied missing details', () => {
    assert.deepEqual(createCallRequest({
        callId: 'call-2', employeeId: 'ashraf', callType: 'meeting',
        meeting: { id: 'meeting-1', project: 'private details', team: '' },
        meetingOwner: 'م. محمود', meetingLocation: 'قاعة 2', meetingMode: 'in_person', confirmedEndedMeeting: true
    }), {
        callId: 'call-2', employeeId: 'ashraf', callType: 'meeting', meetingId: 'meeting-1',
        meetingOwner: 'م. محمود', meetingLocation: 'قاعة 2', meetingMode: 'in_person', confirmedEndedMeeting: true
    });
});
