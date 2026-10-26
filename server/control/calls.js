import {
    ADMIN_ROLES,
    CONTROL_EMPLOYEES,
    firebaseDatabaseRequest,
    getBusyMeetingDetails,
    listSelectableMeetings,
    loadFreshMeetings,
    readJsonBody,
    requireAdmin,
    sendError
} from './shared.js';
import { prepareSpeechRequest, SPEECH_MAX_CHARS } from './audio-cache.js';

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
    const employeeName = {
        mojahed: 'مُجَاهِد',
        mahmoud: 'مَحْمُود',
        ashraf: 'أَشْرَف',
        hossam: 'حُسَام',
        shady: 'شَادِي'
    }[employee.id] || employee.name.replace(/^م\.\s*/, '');
    const callers = {
        'الأستاذ محمد الزهراني': 'الأستاذ مُحَمَّد الزَّهْرَانِي',
        'المهندس محمد القحطاني': 'المهندس مُحَمَّد القَحْطَانِي',
        'الأستاذ محمد العتيبي': 'الأستاذ مُحَمَّد العُتَيْبِي'
    };
    const spokenCaller = callers[callerName] || callerName;
    if (callType === 'office') return `تنبيه إداري. المهندس ${employeeName}، يُرجى التوجّه إلى مكتب ${spokenCaller}. شكرًا لتعاونك.`;
    const prefix = `تنبيه إداري. المهندس ${employeeName}، يُرجى الدخول إلى الاجتماع: `;
    const suffix = '. شكرًا لتعاونك.';
    const available = SPEECH_MAX_CHARS - Array.from(prefix + suffix).length;
    const title = sanitizeSpeechMeetingTitle(meetingTitle);
    const characters = Array.from(title);
    let spokenTitle = title;
    if (characters.length > available) {
        spokenTitle = characters.slice(0, available).join('').replace(/\s+\S*$/, '').trim();
        if (!spokenTitle) spokenTitle = 'الاجتماع المحدد';
    }
    return prefix + spokenTitle + suffix;
}

export function prepareCallSpeech(employee, callType, callerName, meetingTitle = '') {
    try {
        const descriptor = prepareSpeechRequest(makeCallText(employee, callType, callerName, meetingTitle));
        return { descriptor, audioCacheKey: descriptor.cacheKey, audioStatus: 'pending' };
    } catch {
        // Broken optional speech settings must never suppress the visual announcement.
        return { descriptor: null, audioCacheKey: '', audioStatus: 'failed' };
    }
}

async function removeExpiredCalls() {
    const [calls, audioRequests] = await Promise.all([
        firebaseDatabaseRequest('calls/public'),
        firebaseDatabaseRequest('calls/audioRequests')
    ]);
    const now = Date.now();
    await Promise.all([
        ...Object.entries(calls || {}).filter(([, event]) => !event || Number(event.expiresAt) <= now)
            .map(([id]) => firebaseDatabaseRequest(`calls/public/${id}`, 'DELETE')),
        ...Object.entries(audioRequests || {}).filter(([, item]) => !item || Number(item.expiresAt) <= now)
            .map(([id]) => firebaseDatabaseRequest(`calls/audioRequests/${id}`, 'DELETE'))
    ]);
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

        // Only a private, short-lived text descriptor is retained. No audio bytes or meeting
        // titles are placed in the public display feed or in Firestore.
        const speech = prepareCallSpeech(employee, callType, actorRole.callerName, selectedMeeting?.project);
        await removeExpiredCalls();
        const createdAt = Date.now();
        const expiresAt = createdAt + 10 * 60 * 1000;
        if (speech.descriptor) {
            await firebaseDatabaseRequest(`calls/audioRequests/${callId}`, 'PUT', {
                ...speech.descriptor, expiresAt, generationAttempted: false
            });
        }
        const event = {
            id: callId,
            employeeId: employee.id,
            employeeName: employee.name,
            callType,
            audioCacheKey: speech.audioCacheKey,
            audioStatus: speech.audioStatus,
            status: 'sent',
            createdAt,
            expiresAt
        };
        await firebaseDatabaseRequest(`calls/public/${callId}`, 'PUT', event);
        response.setHeader('Cache-Control', 'no-store');
        return response.status(201).json({
            eventId: callId,
            status: event.status,
            audioStatus: event.audioStatus,
            audioCache: 'display-local',
            speechConfigured: Boolean(process.env.GROQ_API_KEY?.trim()),
            meeting: selectedMeeting ? { id: selectedMeeting.id, title: selectedMeeting.project } : null
        });
    } catch (error) {
        return sendError(response, error, 'تعذر إرسال النداء؛ لم يتم تأكيد الإرسال');
    }
}
