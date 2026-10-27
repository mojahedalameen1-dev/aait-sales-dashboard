import { formatTodayDate, getMeetingTimingState, isCancelled } from '../src/data.js';

export function meetingDisplayState(meeting, now = new Date()) {
    if (isCancelled(meeting)) return 'cancelled';
    const state = getMeetingTimingState(meeting, now).state;
    return state === 'overdue' ? 'done' : state;
}

export function sortMeetingsForGrid(meetings, now = new Date()) {
    const priority = { running: 0, upcoming: 1, done: 2, cancelled: 3, invalid: 4 };
    const today = formatTodayDate(now);
    return [...(meetings || [])].filter(meeting => meeting.date === today).map((meeting, index) => ({
        meeting,
        index,
        state: meetingDisplayState(meeting, now),
        start: getMeetingTimingState(meeting, now).startMinutes ?? Infinity
    })).sort((left, right) => (priority[left.state] ?? 4) - (priority[right.state] ?? 4)
        || left.start - right.start
        || left.index - right.index)
        .map(item => ({ ...item.meeting, state: item.state }));
}

export function meetingMode(meeting) {
    const via = String(meeting?.via || '').normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .toLowerCase();
    if (/(حضوري|مكتب|داخل المقر|in\s*person|onsite|on\s*site)/i.test(via)) return 'in_person';
    if (/(عن\s*بعد|اونلاين|online|remote|zoom|meet)/i.test(via) || Boolean(meeting?.meetUrl)) return 'online';
    return '';
}
