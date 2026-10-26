import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ADMIN_ROLES,
    CONTROL_EMPLOYEES,
    getActiveMeetingsForEmployee,
    getBusyMeetingDetails,
    listSelectableMeetings,
    meetingAssignedToEmployee,
    sanitizeMeetingForAdmin,
    verifyFirebaseIdToken,
    isTrustedDisplay
} from '../server/control/shared.js';
import { makeCallText, sanitizeSpeechMeetingTitle, prepareCallSpeech } from '../server/control/calls.js';
import { createRiyadhPrayerAlerts } from '../src/prayer-alerts.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
}

function makeMeeting(overrides = {}) {
    return {
        id: 'meeting-1',
        date: '2026/10/24',
        time: '12:00',
        project: 'اجتماع متابعة تطبيق الشبكة AA81747',
        team: 'م. أشرف',
        via: 'عن بعد',
        status: 'قائم',
        clientStatus: 'مؤكد',
        ticketUrl: 'https://aait.sa/odoo/crm/81747',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        ...overrides
    };
}

test('fixed roles grant only the explicitly documented call types', () => {
    assert.deepEqual(ADMIN_ROLES.general_manager, { label: 'المدير العام', office: true, meeting: false, callerName: 'الأستاذ محمد الزهراني' });
    assert.equal(ADMIN_ROLES.business_development_manager.meeting, true);
    assert.equal(ADMIN_ROLES.deputy_general_manager.office, true);
    assert.deepEqual(CONTROL_EMPLOYEES.map(employee => employee.id), ['mojahed', 'mahmoud', 'ashraf', 'hossam', 'shady']);
});

test('voice phrases identify the calling manager and safely name the selected meeting', () => {
    const mahmoud = CONTROL_EMPLOYEES.find(employee => employee.id === 'mahmoud');
    assert.equal(makeCallText(mahmoud, 'office', ADMIN_ROLES.general_manager.callerName), 'تنبيه إداري. المهندس مَحْمُود، يُرجى التوجّه إلى مكتب الأستاذ مُحَمَّد الزَّهْرَانِي. شكرًا لتعاونك.');
    assert.equal(sanitizeSpeechMeetingTitle('اجتماع تطوير الشبكة AA81747 https://meet.google.com/secret'), 'اجتماع تطوير الشبكة');
    assert.equal(makeCallText(mahmoud, 'meeting', '', 'مناقشة مشروع التطوير'), 'تنبيه إداري. المهندس مَحْمُود، يُرجى الدخول إلى الاجتماع: مناقشة مشروع التطوير. شكرًا لتعاونك.');
    assert.equal(sanitizeSpeechMeetingTitle('اجتماع بيانات عميل خاص 0501234567'), 'الاجتماع المحدد');
});

test('the 15 fixed office announcements fit Groq input limits and remain distinct by employee and manager', () => {
    const phrases = [];
    for (const employee of CONTROL_EMPLOYEES) {
        for (const role of Object.values(ADMIN_ROLES)) {
            const phrase = makeCallText(employee, 'office', role.callerName);
            assert.ok(Array.from(phrase).length <= 200);
            phrases.push(phrase);
        }
    }
    assert.equal(phrases.length, 15);
    assert.equal(new Set(phrases).size, 15);
});

test('long meeting titles fit the 200-character model limit and bad speech settings preserve visual delivery', () => {
    const employee = CONTROL_EMPLOYEES[0];
    assert.ok(Array.from(makeCallText(employee, 'meeting', '', 'مناقشة تطوير النظام '.repeat(30))).length <= 200);
    const previous = process.env.GROQ_VOICE;
    process.env.GROQ_VOICE = 'invalid';
    try { assert.deepEqual(prepareCallSpeech(employee, 'office', ADMIN_ROLES.general_manager.callerName), { descriptor: null, audioCacheKey: '', audioStatus: 'failed' }); }
    finally { if (previous === undefined) delete process.env.GROQ_VOICE; else process.env.GROQ_VOICE = previous; }
});

test('unknown anonymous identities cannot consume a trusted display generation attempt', () => {
    const previous = process.env.CALL_DISPLAY_UIDS_JSON;
    process.env.CALL_DISPLAY_UIDS_JSON = '["screen-qa-0001"]';
    try {
        assert.equal(isTrustedDisplay({ sub: 'screen-qa-0001', firebase: { sign_in_provider: 'anonymous' } }), true);
        assert.equal(isTrustedDisplay({ sub: 'untrusted-0001', firebase: { sign_in_provider: 'anonymous' } }), false);
        assert.equal(isTrustedDisplay({ sub: 'screen-qa-0001', firebase: { sign_in_provider: 'custom' } }), false);
        process.env.CALL_DISPLAY_UIDS_JSON = 'invalid';
        assert.equal(isTrustedDisplay({ sub: 'screen-qa-0001', firebase: { sign_in_provider: 'anonymous' } }), false);
    } finally { if (previous === undefined) delete process.env.CALL_DISPLAY_UIDS_JSON; else process.env.CALL_DISPLAY_UIDS_JSON = previous; }
});

test('busy detection finds only a matching assigned engineer in a live, non-cancelled meeting', () => {
    const now = new Date('2026-10-24T12:30:00+03:00');
    const meetings = [
        makeMeeting(),
        makeMeeting({ id: 'cancelled', status: 'لم يتم' }),
        makeMeeting({ id: 'other-engineer', team: 'م. شادي' }),
        makeMeeting({ id: 'finished', time: '11:00' }),
        makeMeeting({ id: 'future', time: '13:00' })
    ];
    assert.equal(meetingAssignedToEmployee(meetings[0], CONTROL_EMPLOYEES[2]), true);
    assert.equal(getActiveMeetingsForEmployee(meetings, 'ashraf', now).length, 1);
    assert.equal(getActiveMeetingsForEmployee(meetings, 'shady', now).length, 1);
    const details = getBusyMeetingDetails(meetings, 'ashraf', now);
    assert.equal(details[0].expectedEndTime, '13:00');
    assert.equal(details[0].durationMinutes, 60);
    assert.equal(details[0].meetUrl, 'https://meet.google.com/abc-defg-hij');
});

test('admin meeting details keep safe links and never invent absent source data', () => {
    const detail = sanitizeMeetingForAdmin(makeMeeting({
        clientStatus: '',
        meetUrl: 'javascript:alert(1)',
        ticketUrl: 'https://example.invalid/ticket'
    }));
    assert.equal(detail.expectedEndTime, '13:00');
    assert.equal(detail.clientStatus, '');
    assert.equal(detail.meetUrl, '');
    assert.equal(detail.ticketUrl, '');
});

test('meeting call choices include only today’s upcoming or running non-cancelled meetings', () => {
    const now = new Date('2026-10-24T12:30:00+03:00');
    const meetings = [
        makeMeeting(),
        makeMeeting({ id: 'future', time: '13:00' }),
        makeMeeting({ id: 'done', status: 'تم' }),
        makeMeeting({ id: 'cancelled', status: 'ملغي' }),
        makeMeeting({ id: 'yesterday', date: '2026/10/23' })
    ];
    assert.deepEqual(listSelectableMeetings(meetings, now).map(meeting => meeting.id), ['meeting-1', 'future']);
});

test('Firebase verification rejects malformed tokens without making a network request', async () => {
    const previous = process.env.FIREBASE_PROJECT_ID;
    process.env.FIREBASE_PROJECT_ID = 'test-project';
    try {
        await assert.rejects(() => verifyFirebaseIdToken('not-a-token'), /جلسة الدخول غير صالحة/);
    } finally {
        if (previous === undefined) delete process.env.FIREBASE_PROJECT_ID;
        else process.env.FIREBASE_PROJECT_ID = previous;
    }
});

test('Riyadh prayer alert is persisted and emitted once per prayer even after a page reload', async () => {
    const storage = memoryStorage();
    const date = '2026-10-24';
    const base = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(base - 1000);
    const payload = {
        days: [{ date, timings: { Fajr: '04:30', Dhuhr: '12:00', Asr: '15:10', Maghrib: '17:45', Isha: '19:15' } }]
    };
    const service = { load: async city => { assert.equal(city, 'riyadh'); return payload; } };
    const alerts = [];
    const scheduler = createRiyadhPrayerAlerts({ storage, service, now: () => current, onAlert: alert => alerts.push(alert) });
    await scheduler.refresh();
    scheduler.tick(current);
    current = new Date(base + 1000);
    scheduler.tick(current);
    scheduler.tick(new Date(base + 2000));
    scheduler.destroy();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].key, 'Dhuhr');

    const secondScheduler = createRiyadhPrayerAlerts({ storage, service, now: () => new Date(base + 3000), onAlert: alert => alerts.push(alert) });
    await secondScheduler.refresh();
    secondScheduler.tick(new Date(base + 4000));
    secondScheduler.destroy();
    assert.equal(alerts.length, 1);
});
