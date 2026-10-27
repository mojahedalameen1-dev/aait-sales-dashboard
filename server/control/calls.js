import {
    ADMIN_ROLES,
    CONTROL_EMPLOYEES,
    firebaseDatabaseReadWithEtag,
    firebaseDatabaseRequest,
    getBusyMeetingDetails,
    getMeetingMode,
    listTodayMeetings,
    loadFreshMeetings,
    readJsonBody,
    requireAdmin,
    sendError
} from './shared.js';
import { prepareSpeechRequest, SPEECH_MAX_CHARS } from './audio-cache.js';

const CALL_TYPES = new Set(['office', 'meeting']);
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const REPEAT_CALL_WINDOW_MS = 2 * 60 * 1000;

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

function sanitizeSpeechContext(value, maxLength = 32) {
    return Array.from(String(value || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()).slice(0, maxLength).join('').trim();
}

function sanitizeSpeechOwner(value) {
    return sanitizeSpeechContext(value, 32)
        .replace(/^(?:مع\s+)?(?:المهندس|مهندس|م\s*\.?|m\s*\.?)\s*/i, '')
        .trim();
}

function pronounceSpeechOwner(value) {
    const normalized = value.normalize('NFC').replace(/[\u064B-\u065F\u0670]/g, '').toLocaleLowerCase();
    if (!/^(?:مجاهد|mojahed)(?=$|\s)/iu.test(normalized)) return value;
    return value.replace(/^[^\s]+/u, 'مُجاهد');
}

function fitSpeechTitle(title, prefix, suffix) {
    const available = Math.max(0, SPEECH_MAX_CHARS - Array.from(prefix + suffix).length);
    const characters = Array.from(title);
    if (characters.length <= available) return title;
    const shortened = characters.slice(0, available).join('').replace(/\s+\S*$/, '').trim();
    return shortened || (available >= 3 ? '…' : '');
}

export function makeCallText(employee, callType, callerName, meetingTitle = '', meetingContext = {}) {
    const employeeName = {
        mojahed: 'مُجاهد',
        mahmoud: 'مَحْمُود',
        ashraf: 'أَشْرَف',
        hossam: 'حُسَام',
        shady: 'شَادِي'
    }[employee.id] || employee.name.replace(/^م\.\s*/, '');
    const callers = {
        'الأستاذ محمد الزهراني': { spoken: 'الأستاذ مُحَمَّد الزَّهْرَانِي', office: 'المدير العام، الأستاذ مُحَمَّد الزَّهْرَانِي' },
        'المهندس محمد القحطاني': { spoken: 'المهندس مُحَمَّد القَحْطَانِي', office: 'مدير تطوير الأعمال، المهندس مُحَمَّد القَحْطَانِي' },
        'الأستاذ محمد العتيبي': { spoken: 'الأستاذ مُحَمَّد العُتَيْبِي', office: 'نائب المدير العام، الأستاذ مُحَمَّد العُتَيْبِي' }
    };
    const caller = callers[callerName] || { spoken: sanitizeSpeechContext(callerName, 40), office: sanitizeSpeechContext(callerName, 40) };
    if (callType === 'office') return `يُرجى من المهندس ${employeeName} التوجّه الآن إلى مكتب ${caller.office}. شكرًا لك.`;

    const safeTitle = sanitizeSpeechMeetingTitle(meetingTitle);
    const title = safeTitle.replace(/^اجتماع\s+/u, '').trim() || safeTitle;
    const owner = pronounceSpeechOwner(sanitizeSpeechOwner(meetingContext.ownerName));
    const location = sanitizeSpeechContext(meetingContext.location);
    const ownerPhrase = /^(?:الفريق|فريق)(?:\s|$)|^team(?:\s|$)/i.test(owner) ? `التابع لـ ${owner}` : `التابع للمهندس ${owner}`;
    const suffix = `، ${ownerPhrase}، بناءً على طلب ${caller.spoken}.`;
    if ((meetingContext.mode || meetingContext.meetingMode) === 'in_person') {
        const prefix = `المهندس ${employeeName}، يُرجى التوجّه الآن إلى ${location}، للمشاركة في اجتماع `;
        return `${prefix}${fitSpeechTitle(title, prefix, suffix)}${suffix}`;
    }
    const prefix = `المهندس ${employeeName}، يُرجى الانضمام الآن إلى اجتماع `;
    return `${prefix}${fitSpeechTitle(title, prefix, suffix)}${suffix}`;
}

export function prepareCallSpeech(employee, callType, callerName, meetingTitle = '', meetingContext = {}) {
    try {
        const descriptor = prepareSpeechRequest(makeCallText(employee, callType, callerName, meetingTitle, meetingContext));
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
    return calls || {};
}

function findRecentEmployeeCall(calls, employeeId, now = Date.now()) {
    return Object.values(calls || {})
        .filter(event => event?.employeeId === employeeId
            && Number.isFinite(Number(event.createdAt))
            && Number(event.createdAt) <= now
            && now - Number(event.createdAt) < REPEAT_CALL_WINDOW_MS)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] || null;
}

function recentCallConfirmation(recent, employee, now = Date.now()) {
    const createdAt = Number(recent.createdAt);
    const ageMs = Math.max(0, now - createdAt);
    return {
        code: 'RECENT_DUPLICATE_CALL',
        employee: employee.name,
        previousCallType: recent.callType === 'office' ? 'office' : 'meeting',
        previousCallCreatedAt: createdAt,
        ageMs,
        repeatWindowMs: REPEAT_CALL_WINDOW_MS,
        message: `تم إرسال نداء إلى ${employee.name} قبل ${ageMs < 60_000 ? 'أقل من دقيقة' : `${Math.floor(ageMs / 60_000)} دقيقة`}. هل ترغب في إعادة النداء؟`
    };
}

async function reserveRecentCallGuard(employee, callId, callType, createdAt, confirmedRecentDuplicate) {
    const path = `calls/recentCallGuards/${employee.id}`;
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await firebaseDatabaseReadWithEtag(path);
        const guard = current.data;
        if (guard?.callId === callId) return { acquired: true, path };
        if (Number(guard?.expiresAt) > createdAt && !confirmedRecentDuplicate) {
            return { duplicate: guard };
        }
        const nextGuard = {
            callId,
            employeeId: employee.id,
            employeeName: employee.name,
            callType,
            createdAt,
            expiresAt: createdAt + REPEAT_CALL_WINDOW_MS
        };
        try {
            await firebaseDatabaseRequest(path, 'PUT', nextGuard, { 'if-match': current.etag });
            return { acquired: true, path };
        } catch (error) {
            if (error.statusCode !== 412) throw error;
        }
    }
    throw Object.assign(new Error('تعذر تثبيت حالة النداء؛ أعد المحاولة بعد لحظات'), { statusCode: 503 });
}

async function releaseRecentCallGuard(guard, callId) {
    if (!guard?.path) return;
    try {
        const current = await firebaseDatabaseReadWithEtag(guard.path);
        if (current.data?.callId === callId) {
            await firebaseDatabaseRequest(guard.path, 'DELETE', undefined, { 'if-match': current.etag });
        }
    } catch { /* A short-lived guard can safely expire if cleanup is unavailable. */ }
}

export default async function handler(request, response) {
    let reservedGuard = null;
    let reservedCallId = '';
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
        const confirmedRecentDuplicate = body.confirmedRecentDuplicate === true;
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
            selectedMeeting = listTodayMeetings(meetings).find(item => item.id === meetingId) || null;
            if (!selectedMeeting) return response.status(409).json({ error: 'الاجتماع لم يعد موجودًا في جدول اليوم؛ حدّث القائمة واختر اجتماعًا صالحًا' });
            if (selectedMeeting.state === 'cancelled') return response.status(409).json({ error: 'لا يمكن إرسال نداء لاجتماع ملغي أو حالته لم يتم' });
            if (selectedMeeting.state === 'invalid') return response.status(409).json({ error: 'وقت الاجتماع غير صالح؛ تعذر إرسال النداء' });
            if (selectedMeeting.state === 'done' && body.confirmedEndedMeeting !== true) {
                return response.status(409).json({ code: 'ENDED_MEETING_CONFIRMATION_REQUIRED', error: 'الاجتماع منتهٍ؛ أكّد رغبتك في إرسال النداء قبل المتابعة' });
            }
            const mode = getMeetingMode(selectedMeeting) || (['online', 'in_person'].includes(body.meetingMode) ? body.meetingMode : '');
            const ownerName = String(selectedMeeting.team || body.meetingOwner || '').trim();
            const location = String(selectedMeeting.location || body.meetingLocation || '').trim();
            if (!ownerName) return response.status(400).json({ code: 'MEETING_OWNER_REQUIRED', error: 'أدخل اسم المهندس صاحب الاجتماع قبل الإرسال' });
            if (!mode) return response.status(400).json({ code: 'MEETING_MODE_REQUIRED', error: 'حدّد هل الاجتماع عن بُعد أو حضوري قبل الإرسال' });
            if (mode === 'in_person' && !location) return response.status(400).json({ code: 'MEETING_LOCATION_REQUIRED', error: 'أدخل مكان الاجتماع الحضوري قبل الإرسال' });
            selectedMeeting = { ...selectedMeeting, mode, meetingMode: mode, ownerName, location };
        }

        const publicCalls = await removeExpiredCalls();
        const recentCall = findRecentEmployeeCall(publicCalls, employee.id);
        if (recentCall && !confirmedRecentDuplicate) {
            response.setHeader('Cache-Control', 'no-store');
            return response.status(409).json(recentCallConfirmation(recentCall, employee));
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
        const speech = prepareCallSpeech(employee, callType, actorRole.callerName, selectedMeeting?.project, selectedMeeting);
        const createdAt = Date.now();
        const expiresAt = createdAt + 10 * 60 * 1000;
        const guard = await reserveRecentCallGuard(employee, callId, callType, createdAt, confirmedRecentDuplicate);
        if (guard.duplicate) {
            response.setHeader('Cache-Control', 'no-store');
            return response.status(409).json(recentCallConfirmation(guard.duplicate, employee, createdAt));
        }
        reservedGuard = guard;
        reservedCallId = callId;
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
        reservedGuard = null;
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
        await releaseRecentCallGuard(reservedGuard, reservedCallId);
        return sendError(response, error, 'تعذر إرسال النداء؛ لم يتم تأكيد الإرسال');
    }
}
