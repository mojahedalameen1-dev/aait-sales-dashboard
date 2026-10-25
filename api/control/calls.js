import {
    ADMIN_ROLES,
    CONTROL_EMPLOYEES,
    firebaseDatabaseRequest,
    getBusyMeetingDetails,
    getOrCreateSpeech,
    listSelectableMeetings,
    loadFreshMeetings,
    readJsonBody,
    requireAdmin,
    sendError
} from './shared.js';

const CALL_TYPES = new Set(['office', 'meeting']);
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

export function sanitizeSpeechMeetingTitle(project) {
    const raw = String(project || '').trim();
    if (!raw || /(عميل|عميلة|بيانات\s+عميل|customer|client|هاتف|جوال|\b\d{8,}\b)/i.test(raw)) return 'الاجتماع المحدد';
    const title = raw
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\bAA\s*\d+\b/gi, ' ')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–—:،]+|[\s\-–—:،]+$/g, '')
        .slice(0, 120)
        .trim();
    return title || 'الاجتماع المحدد';
}

export function makeCallText(employee, callType, callerName, meetingTitle = '') {
    const employeeName = employee.name.replace(/^م\.\s*/, '');
    return callType === 'office'
        ? `المهندس ${employeeName}، يرجى التوجه إلى مكتب ${callerName}.`
        : `المهندس ${employeeName}، يرجى الدخول إلى اجتماع ${sanitizeSpeechMeetingTitle(meetingTitle)}.`;
}

async function removeExpiredCalls() {
    const calls = await firebaseDatabaseRequest('calls/public');
    const now = Date.now();
    await Promise.all(Object.entries(calls || {})
        .filter(([, event]) => !event || Number(event.expiresAt) <= now)
        .map(([id]) => firebaseDatabaseRequest(`calls/public/${id}`, 'DELETE')));
}

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const actor = await requireAdmin(request, response);
        const body = await readJsonBody(request);
        const employee = CONTROL_EMPLOYEES.find(item => item.id === body.employeeId);
        const callType = body.callType;
        const callId = body.callId;
        const meetingId = typeof body.meetingId === 'string' ? body.meetingId : '';
        const confirmedBusy = body.confirmedBusy === true;
        const actorRole = ADMIN_ROLES[actor.roleId];

        if (!employee || !CALL_TYPES.has(callType) || !CALL_ID_PATTERN.test(callId || '')) {
            return response.status(400).json({ error: 'اختر الموظف ونوع النداء بشكل صحيح ثم أعد المحاولة' });
        }
        if (!actorRole?.[callType]) return response.status(403).json({ error: 'صلاحية هذا الحساب لا تسمح بنوع النداء المختار' });
        if ((callType === 'meeting' && !meetingId) || (callType === 'office' && meetingId)) {
            return response.status(400).json({ error: 'بيانات النداء لا تتطابق مع نوعه' });
        }

        const existing = await firebaseDatabaseRequest(`calls/public/${callId}`);
        if (existing) {
            return response.status(200).json({
                eventId: callId,
                status: existing.status || 'sent',
                audioStatus: existing.audioStatus || 'not_configured',
                duplicate: true
            });
        }

        // Refresh the source for both call types. If the source cannot be checked,
        // fail closed rather than sending a call to an employee whose status is unknown.
        const source = await loadFreshMeetings();
        const meetings = source.meetings;
        let selectedMeeting = null;
        if (callType === 'meeting') {
            selectedMeeting = listSelectableMeetings(meetings).find(item => item.id === meetingId) || null;
            if (!selectedMeeting) return response.status(409).json({ error: 'الاجتماع لم يعد متاحًا؛ حدّث القائمة واختر اجتماعًا صالحًا' });
        }

        const conflicts = getBusyMeetingDetails(meetings, employee.id);
        if (conflicts.length && !confirmedBusy) {
            return response.status(409).json({
                code: 'EMPLOYEE_BUSY',
                employee: employee.name,
                message: `المهندس ${employee.name} مرتبط حاليًا باجتماع جارٍ. هل ترغب في إرسال النداء رغم انشغاله؟`,
                conflicts
            });
        }

        // Project titles are spoken only for meeting calls; sensitive/customer markers, ticket IDs
        // and links are removed before synthesis, and the raw phrase is never persisted in the event.
        const speechText = makeCallText(employee, callType, actorRole.callerName, selectedMeeting?.project);
        const speech = await getOrCreateSpeech(speechText);
        await removeExpiredCalls();
        const event = {
            id: callId,
            employeeId: employee.id,
            employeeName: employee.name,
            callType,
            audioBase64: speech.audioBase64,
            audioStatus: speech.status,
            status: 'sent',
            createdAt: Date.now(),
            expiresAt: Date.now() + 10 * 60 * 1000
        };
        await firebaseDatabaseRequest(`calls/public/${callId}`, 'PUT', event);
        response.setHeader('Cache-Control', 'no-store');
        return response.status(201).json({
            eventId: callId,
            status: event.status,
            audioStatus: event.audioStatus,
            speechConfigured: event.audioStatus !== 'not_configured',
            meeting: selectedMeeting ? { id: selectedMeeting.id, title: selectedMeeting.project } : null
        });
    } catch (error) {
        return sendError(response, error, 'تعذر إرسال النداء؛ لم يتم تأكيد الإرسال');
    }
}
