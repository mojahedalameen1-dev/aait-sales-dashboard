import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallRequest, syncMeetingFieldState } from '../control/call-form-state.js';

function fields() {
    return { section: { hidden: false }, select: { required: true, disabled: false } };
}

test('office calls disable the hidden meeting field and remove its required constraint for every role', () => {
    for (const canCallMeeting of [false, true]) {
        const { section, select } = fields();
        syncMeetingFieldState(section, select, { callType: 'office', canCallMeeting });
        assert.equal(section.hidden, true);
        assert.equal(select.required, false);
        assert.equal(select.disabled, true);
    }
});

test('authorized meeting calls require a visible enabled meeting field only after loading completes', () => {
    const { section, select } = fields();
    syncMeetingFieldState(section, select, { callType: 'meeting', canCallMeeting: true, loading: true });
    assert.equal(section.hidden, false);
    assert.equal(select.required, true);
    assert.equal(select.disabled, true);
    syncMeetingFieldState(section, select, { callType: 'meeting', canCallMeeting: true, loading: false });
    assert.equal(section.hidden, false);
    assert.equal(select.required, true);
    assert.equal(select.disabled, false);
});

test('finishing a meeting fetch cannot enable hidden fields after switching to an office call', () => {
    const { section, select } = fields();
    syncMeetingFieldState(section, select, { callType: 'meeting', canCallMeeting: true, loading: true });
    syncMeetingFieldState(section, select, { callType: 'office', canCallMeeting: true, loading: true });
    syncMeetingFieldState(section, select, { callType: 'office', canCallMeeting: true, loading: false });
    assert.deepEqual({ hidden: section.hidden, ...select }, { hidden: true, required: false, disabled: true });
});

test('meeting controls stay hidden and disabled for an office-only administrator', () => {
    const { section, select } = fields();
    assert.equal(syncMeetingFieldState(section, select, { callType: 'meeting', canCallMeeting: false }), false);
    assert.deepEqual({ hidden: section.hidden, ...select }, { hidden: true, required: false, disabled: true });
});

test('office call requests never include a stale meeting selection', () => {
    assert.deepEqual(createCallRequest({ callId: 'call-1', employeeId: 'mojahed', callType: 'office', meeting: { id: 'previous-meeting' } }), {
        callId: 'call-1', employeeId: 'mojahed', callType: 'office'
    });
});

test('meeting call requests include only the selected meeting ID', () => {
    assert.deepEqual(createCallRequest({ callId: 'call-2', employeeId: 'ashraf', callType: 'meeting', meeting: { id: 'meeting-1', project: 'private details' } }), {
        callId: 'call-2', employeeId: 'ashraf', callType: 'meeting', meetingId: 'meeting-1'
    });
});
