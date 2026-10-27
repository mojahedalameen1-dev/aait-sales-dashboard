/** Keep hidden meeting fields out of native validation and office-call payloads. */
export function syncMeetingFieldState(section, grid, { callType, canCallMeeting, loading = false }) {
    const active = canCallMeeting && callType === 'meeting';
    section.hidden = !active;
    grid.setAttribute('aria-disabled', String(!active || loading));
    grid.setAttribute('aria-busy', String(Boolean(active && loading)));
    grid.inert = !active || loading;
    return active;
}

export function createCallRequest({ callId, employeeId, callType, meeting, meetingOwner = '', meetingLocation = '', meetingMode = '', confirmedEndedMeeting = false }) {
    return {
        callId,
        employeeId,
        callType,
        ...(callType === 'meeting' && meeting?.id ? {
            meetingId: meeting.id,
            meetingOwner: meetingOwner || meeting.team || '',
            meetingLocation: meetingLocation || meeting.location || '',
            meetingMode,
            confirmedEndedMeeting: Boolean(confirmedEndedMeeting)
        } : {})
    };
}
