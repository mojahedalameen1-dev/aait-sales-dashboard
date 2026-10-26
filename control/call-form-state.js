/** Keep hidden meeting fields out of native validation and office-call payloads. */
export function syncMeetingFieldState(section, select, { callType, canCallMeeting, loading = false }) {
    const active = canCallMeeting && callType === 'meeting';
    section.hidden = !active;
    select.required = active;
    select.disabled = !active || loading;
    return active;
}

export function createCallRequest({ callId, employeeId, callType, meeting }) {
    return {
        callId,
        employeeId,
        callType,
        ...(callType === 'meeting' && meeting?.id ? { meetingId: meeting.id } : {})
    };
}
