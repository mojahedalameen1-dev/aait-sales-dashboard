import './control.css';
import { createCallRequest, syncMeetingFieldState } from './call-form-state.js';
import { meetingDisplayState, meetingMode, sortMeetingsForGrid } from './meeting-grid.js';
import { formatTime12h, formatTodayDate, getCurrentTimeParts } from '../src/data.js';
import { createIcons, Building2, CalendarDays, Check, CircleCheck, CircleHelp, CircleUserRound, CircleX, Clock3, ExternalLink, Info, KeyRound, LayoutDashboard, LoaderCircle, LogIn, LogOut, PhoneCall, Radio, RefreshCw, Send, ShieldAlert, TriangleAlert, UserRoundCheck, UsersRound, Video, X } from 'lucide';

const ICONS = { Building2, CalendarDays, Check, CircleCheck, CircleHelp, CircleUserRound, CircleX, Clock3, ExternalLink, Info, KeyRound, LayoutDashboard, LoaderCircle, LogIn, LogOut, PhoneCall, Radio, RefreshCw, Send, ShieldAlert, TriangleAlert, UserRoundCheck, UsersRound, Video, X };
const EMPLOYEES = [
    { id: 'mojahed', name: 'م. مجاهد', color: '#9a78ff' },
    { id: 'mahmoud', name: 'م. محمود', color: '#f6b94a' },
    { id: 'ashraf', name: 'م. أشرف', color: '#3896ff' },
    { id: 'hossam', name: 'م. حسام', color: '#00c98a' },
    { id: 'shady', name: 'م. شادي', color: '#ef5da8' }
];
const DESIGN_PREVIEW = import.meta.env.DEV && new URLSearchParams(location.search).get('design-preview') === '1';
const $ = selector => document.querySelector(selector);
const setupView = $('#setup-view');
const loginView = $('#login-view');
const appView = $('#app-view');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const loginButton = $('#login-submit');
const passwordPanel = $('#password-panel');
const passwordForm = $('#change-password-form');
const passwordResult = $('#password-change-result');
const callForm = $('#call-form');
const sendButton = $('#send-call');
const callResult = $('#call-result');
const meetingSection = $('#meeting-section');
const meetingGrid = $('#meeting-grid');
const meetingDetails = $('#meeting-details');
const meetingsState = $('#meetings-state');
const busyDialog = $('#busy-dialog');
const busyDescription = $('#busy-description');
const busyMeetings = $('#busy-meetings');
const busyConfirmButton = $('#confirm-busy');
const busyCancelButton = $('#cancel-busy');
const duplicateDialog = $('#duplicate-dialog');
const duplicateDescription = $('#duplicate-description');
const duplicateDetails = $('#duplicate-details');
const duplicateConfirmButton = $('#confirm-duplicate');
const duplicateCancelButton = $('#cancel-duplicate');

let clientConfig = null;
let actor = null;
let meetings = [];
let meetingsLoading = false;
let meetingsError = '';
let selectedMeetingId = '';
let meetingContextDrafts = new Map();
let meetingStateInterval = null;
let callSending = false;
let selectedEmployeeId = EMPLOYEES[0].id;
let pendingRequest = null;
let pendingConfirmations = { confirmedBusy: false, confirmedRecentDuplicate: false };
let lastFocus = null;
let statusTimer = null;

function refreshIcons(root = document) {
    createIcons({ root, icons: ICONS });
    root.querySelectorAll('svg[data-lucide]').forEach(icon => icon.removeAttribute('data-lucide'));
}

function setConnectionState(text, state = 'pending') {
    const element = $('#connection-state');
    element.className = `connection-state is-${state}`;
    element.lastChild.textContent = ` ${text}`;
}

function showResult(message, state = 'success') {
    callResult.hidden = false;
    callResult.className = `call-result${state === 'error' ? ' is-error' : state === 'warn' ? ' is-warn' : ''}`;
    callResult.textContent = message;
}

function clearResult() {
    callResult.hidden = true;
    callResult.textContent = '';
    callResult.className = 'call-result';
}

function showSetup(config) {
    document.body.classList.remove('is-login');
    setupView.hidden = false;
    loginView.hidden = true;
    appView.hidden = true;
    const labels = {
        FIREBASE_WEB_API_KEY: 'مفتاح تطبيق Firebase للويب',
        FIREBASE_PROJECT_ID: 'معرّف مشروع Firebase',
        FIREBASE_DATABASE_URL: 'رابط قاعدة Realtime Database',
        FIREBASE_SERVICE_ACCOUNT_JSON: 'حساب خدمة آمن على الخادم',
        CALL_ADMIN_UIDS_JSON: 'ربط أدوار المسؤولين بمعرّفات UID',
        CALL_AUTH_RATE_LIMIT_SECRET: 'مفتاح حماية محاولات الدخول',
        CALL_AUTH_SESSION_SECRET: 'مفتاح توقيع جلسة الدخول الآمنة',
        CONTROL_ADMIN_PASSWORDS: 'تهيئة كلمات مرور المسؤولين لأول مرة عبر أمر الإعداد الآمن'
    };
    const missing = $('#setup-missing');
    missing.replaceChildren(...(config.missing || []).map(item => {
        const li = document.createElement('li');
        li.textContent = labels[item] || item;
        return li;
    }));
    setConnectionState('الإعداد غير مكتمل', 'error');
}

async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
        credentials: 'same-origin',
        cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || 'تعذر إكمال الطلب'), { status: response.status, payload });
    return payload;
}

function formatControlTime(value) {
    const time = String(value || '').trim();
    if (!/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return '—';
    return formatTime12h(time);
}

function renderEmployees() {
    const list = $('#employee-list');
    list.replaceChildren(...EMPLOYEES.map(employee => {
        const label = document.createElement('label');
        label.className = `employee-choice${employee.id === selectedEmployeeId ? ' is-selected' : ''}`;
        label.style.setProperty('--employee-color', employee.color);
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'employeeId';
        input.value = employee.id;
        input.checked = employee.id === selectedEmployeeId;
        input.setAttribute('aria-label', employee.name);
        input.addEventListener('change', () => {
            selectedEmployeeId = employee.id;
            renderEmployees();
            clearResult();
        });
        const avatar = document.createElement('span');
        avatar.className = 'employee-avatar';
        avatar.innerHTML = '<i data-lucide="user-round-check"></i>';
        const name = document.createElement('strong');
        name.className = 'employee-name';
        name.textContent = employee.name;
        const indicator = document.createElement('span');
        indicator.className = 'employee-indicator';
        label.append(input, avatar, name, indicator);
        return label;
    }));
    refreshIcons(list);
}

function selectedCallType() {
    return callForm.querySelector('input[name="callType"]:checked')?.value || 'meeting';
}

function setCallTypeAvailability() {
    const canCallMeeting = actor?.permissions?.meeting === true;
    const meetingOption = $('[data-call-option="meeting"]');
    const meetingRadio = meetingOption.querySelector('input');
    meetingRadio.disabled = !canCallMeeting;
    meetingOption.classList.toggle('is-disabled', !canCallMeeting);
    $('#permission-note').hidden = canCallMeeting;
    if (!canCallMeeting) {
        $('#permission-note').textContent = 'هذا الحساب لا يملك صلاحية إرسال نداءات الاجتماعات.';
        meetingRadio.checked = false;
        callForm.querySelector('input[name="callType"][value="office"]').checked = true;
    }
    callForm.querySelectorAll('.call-type-option').forEach(option => {
        option.classList.toggle('is-selected', option.querySelector('input').checked);
    });
    syncMeetingFieldState(meetingSection, meetingGrid, {
        callType: selectedCallType(), canCallMeeting, loading: meetingsLoading
    });
    updateMeetingDetails();
}

function createDetail(label, value, className = '') {
    const wrapper = document.createElement('div');
    wrapper.className = `meeting-detail${className ? ` ${className}` : ''}`;
    const title = document.createElement('span');
    title.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value || 'غير متوفر في المصدر';
    wrapper.append(title, content);
    return wrapper;
}

function safeLink(url, label, icon) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !['meet.google.com', 'aaait.sa', 'aait.sa'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return null;
        const link = document.createElement('a');
        link.className = 'meeting-link';
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = label;
        const glyph = document.createElement('i');
        glyph.setAttribute('data-lucide', icon);
        link.prepend(glyph);
        return link;
    } catch { return null; }
}

function employeeAliasMatch(meetingTeam, employeeId) {
    const aliases = {
        mojahed: ['مجاهد', 'mojahed'],
        mahmoud: ['محمود', 'mahmoud'],
        ashraf: ['أشرف', 'اشرف', 'ashraf'],
        hossam: ['حسام', 'hossam', 'hussam'],
        shady: ['شادي', 'shady']
    }[employeeId] || [];
    const text = String(meetingTeam || '').normalize('NFKD').replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').toLowerCase();
    return aliases.some(alias => text.includes(alias.normalize('NFKD').replace(/[أإآ]/g, 'ا').toLowerCase()));
}

function renderMeetingDetails(meeting, target) {
    target.replaceChildren();
    target.hidden = !meeting;
    if (!meeting) return;
    const title = document.createElement('strong');
    title.className = 'meeting-detail-title';
    const project = document.createElement('div');
    project.className = 'meeting-detail is-wide';
    const titleLabel = document.createElement('span');
    titleLabel.textContent = 'المشروع / الاجتماع';
    title.textContent = meeting.project || 'غير محدد';
    project.append(titleLabel, title);
    const selectedEmployee = EMPLOYEES.find(item => item.id === selectedEmployeeId);
    const assignedLabel = employeeAliasMatch(meeting.team, selectedEmployeeId)
        ? 'الموظف المختار هو المهندس المعيّن لهذا الاجتماع.'
        : `تنبيه: المهندس المعيّن هو ${meeting.team || 'غير محدد'}، والنداء سيوجّه إلى ${selectedEmployee?.name}.`;
    const assignment = document.createElement('p');
    assignment.className = 'assignment-note';
    assignment.textContent = assignedLabel;
    const draft = meetingContextDrafts.get(meeting.id) || {};
    const mode = meetingMode(meeting) || draft.mode || '';
    const owner = String(meeting.team || draft.ownerName || '').trim();
    const location = String(meeting.location || draft.location || '').trim();
    target.append(project);
    if (owner) target.append(createDetail('صاحب الاجتماع · من بيانات الجدول', owner));
    else target.append(createEditableMeetingDetail(meeting, 'صاحب الاجتماع / الفريق', 'ownerName', draft.ownerName || '', 'اكتب الاسم كما ورد من مسؤول الاجتماع'));
    target.append(createDetail('التاريخ والموعد', `${meeting.date || '—'} · ${formatControlTime(meeting.time)} · الرياض`));

    const modeDetail = document.createElement('div');
    modeDetail.className = 'meeting-detail is-wide';
    const modeLabel = document.createElement('span');
    modeLabel.textContent = 'نوع الاجتماع';
    modeDetail.append(modeLabel);
    if (mode) {
        const modeValue = document.createElement('strong');
        modeValue.textContent = mode === 'in_person' ? 'حضوري' : 'عن بُعد';
        modeDetail.append(modeValue);
    } else {
        const modeChoices = document.createElement('div');
        modeChoices.className = 'meeting-mode-choices';
        modeChoices.setAttribute('role', 'radiogroup');
        modeChoices.setAttribute('aria-label', 'حدد نوع الاجتماع');
        for (const [value, label, icon] of [['online', 'عن بُعد', 'video'], ['in_person', 'حضوري', 'building-2']]) {
            const choice = document.createElement('button');
            choice.type = 'button';
            choice.className = 'meeting-mode-choice';
            choice.setAttribute('role', 'radio');
            choice.setAttribute('aria-checked', String(draft.mode === value));
            choice.tabIndex = draft.mode === value || (!draft.mode && value === 'online') ? 0 : -1;
            choice.textContent = label;
            const glyph = document.createElement('i');
            glyph.setAttribute('data-lucide', icon);
            choice.prepend(glyph);
            choice.addEventListener('click', () => {
                meetingContextDrafts.set(meeting.id, { ...draft, mode: value });
                updateMeetingDetails();
                meetingDetails.querySelector(`.meeting-mode-choice[aria-checked="true"]`)?.focus({ preventScroll: true });
            });
            choice.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                const choices = [...modeChoices.querySelectorAll('.meeting-mode-choice')];
                choices[(choices.indexOf(choice) + 1) % choices.length].click();
            });
            modeChoices.append(choice);
        }
        modeDetail.append(modeChoices);
    }
    target.append(modeDetail);
    if (mode === 'in_person') {
        if (location) target.append(createDetail('مكان الاجتماع · من البيانات', location));
        else target.append(createEditableMeetingDetail(meeting, 'مكان الاجتماع الحضوري', 'location', draft.location || '', 'أدخل الموقع قبل إرسال النداء'));
    }
    target.append(createDetail('نوع الاجتماع في الجدول', meeting.via), createDetail('الحالة', meeting.status || statusLabel(meeting.state)), assignment);

    if (meeting.state === 'done') {
        const confirm = document.createElement('label');
        confirm.className = 'ended-meeting-confirm';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = draft.confirmedEndedMeeting === true;
        checkbox.addEventListener('change', () => {
            const current = meetingContextDrafts.get(meeting.id) || {};
            meetingContextDrafts.set(meeting.id, { ...current, confirmedEndedMeeting: checkbox.checked });
            updateMeetingReadiness(meeting);
        });
        const text = document.createElement('span');
        text.textContent = 'أؤكد إرسال النداء رغم أن الاجتماع منتهٍ';
        confirm.append(checkbox, text);
        target.append(confirm);
    }
    const links = document.createElement('div');
    links.className = 'meeting-detail is-links';
    const linkLabel = document.createElement('span');
    linkLabel.textContent = 'الروابط (للمسؤول فقط)';
    links.append(linkLabel);
    links.append(safeLink(meeting.meetUrl, 'فتح رابط الاجتماع', 'video') || document.createTextNode('لا يوجد رابط اجتماع في المصدر'));
    if (meeting.ticketUrl) links.append(safeLink(meeting.ticketUrl, 'فتح التذكرة', 'external-link'));
    target.append(links);
    refreshIcons(target);
}

function createEditableMeetingDetail(meeting, label, field, value, placeholder) {
    const wrapper = document.createElement('label');
    wrapper.className = 'meeting-detail meeting-detail-input';
    const title = document.createElement('span');
    title.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = field === 'location' ? 80 : 60;
    input.autocomplete = 'off';
    input.placeholder = placeholder;
    input.value = value;
    input.dataset.meetingContext = field;
    input.addEventListener('input', () => {
        const current = meetingContextDrafts.get(meeting.id) || {};
        meetingContextDrafts.set(meeting.id, { ...current, [field]: input.value });
        updateMeetingReadiness(meeting);
    });
    wrapper.append(title, input);
    return wrapper;
}

function statusLabel(state) {
    return ({ running: 'جاري الآن', upcoming: 'قادم', done: 'منتهي', cancelled: 'ملغي أو لم يتم', invalid: 'وقت غير صالح' })[state] || 'الحالة غير محددة';
}

function renderMeetingGrid() {
    const focusedId = document.activeElement?.dataset?.meetingId || '';
    const ordered = sortMeetingsForGrid(meetings);
    meetingGrid.replaceChildren();
    for (const meeting of ordered) {
        const card = document.createElement('button');
        const selected = meeting.id === selectedMeetingId;
        card.type = 'button';
        card.className = `meeting-card is-${meeting.state}${selected ? ' is-selected' : ''}`;
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', String(selected));
        card.setAttribute('aria-label', `${meeting.project || 'اجتماع'}، ${formatControlTime(meeting.time)}, ${statusLabel(meeting.state)}`);
        card.dataset.meetingId = meeting.id;
        card.tabIndex = selected || (!selectedMeetingId && ordered[0]?.id === meeting.id) ? 0 : -1;
        const header = document.createElement('span');
        header.className = 'meeting-card-header';
        const badge = document.createElement('span');
        badge.className = 'meeting-state-badge';
        badge.textContent = statusLabel(meeting.state);
        const time = document.createElement('strong');
        time.className = 'meeting-card-time';
        time.textContent = formatControlTime(meeting.time);
        header.append(badge, time);
        const title = document.createElement('span');
        title.className = 'meeting-card-title';
        title.textContent = meeting.project || 'اجتماع بلا عنوان';
        const owner = document.createElement('span');
        owner.className = 'meeting-card-owner';
        owner.textContent = meeting.team || 'صاحب الاجتماع غير مذكور';
        const metadata = document.createElement('span');
        metadata.className = 'meeting-card-meta';
        const mode = meetingMode(meeting);
        const type = document.createElement('span');
        type.className = 'meeting-card-type';
        type.textContent = mode === 'in_person' ? 'حضوري' : mode === 'online' ? 'عن بُعد' : meeting.via || 'نوع الاجتماع غير محدد';
        metadata.append(type);
        const ticket = meeting.project?.match(/AA\d+/i)?.[0];
        if (ticket) {
            const ticketBadge = document.createElement('span');
            ticketBadge.className = 'meeting-card-ticket';
            ticketBadge.textContent = ticket;
            metadata.append(ticketBadge);
        }
        card.append(header, title, owner, metadata);
        card.addEventListener('click', () => selectMeeting(meeting.id));
        card.addEventListener('keydown', navigateMeetingGrid);
        meetingGrid.append(card);
    }
    meetingGrid.setAttribute('aria-busy', String(meetingsLoading));
    if (focusedId) meetingGrid.querySelector(`[data-meeting-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

function selectMeeting(id) {
    selectedMeetingId = id;
    clearResult();
    renderMeetingGrid();
    updateMeetingDetails();
    meetingGrid.querySelector(`[data-meeting-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function navigateMeetingGrid(event) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const cards = [...meetingGrid.querySelectorAll('.meeting-card')];
    if (!cards.length) return;
    const currentIndex = cards.indexOf(event.currentTarget);
    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = cards.length - 1;
    else {
        const rtl = getComputedStyle(meetingGrid).direction === 'rtl';
        const step = event.key === 'ArrowLeft' ? (rtl ? 1 : -1)
            : event.key === 'ArrowRight' ? (rtl ? -1 : 1)
                : event.key === 'ArrowUp' ? -1 : 1;
        nextIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + step));
    }
    event.preventDefault();
    selectMeeting(cards[nextIndex].dataset.meetingId);
}

function setMeetings(nextMeetings) {
    meetings = sortMeetingsForGrid(nextMeetings);
    if (!meetings.some(meeting => meeting.id === selectedMeetingId)) selectedMeetingId = '';
    meetingsState.textContent = meetings.length
        ? `تم تحميل ${meetings.length} اجتماعات اليوم. اختر اجتماعًا لمراجعة التفاصيل.`
        : meetingsError || 'ما فيه اجتماعات مسجلة اليوم.';
    renderMeetingGrid();
    updateMeetingDetails();
}

function startMeetingStateUpdates() {
    if (meetingStateInterval) clearInterval(meetingStateInterval);
    meetingStateInterval = setInterval(() => {
        if (!actor || appView.hidden || !meetings.length) return;
        meetings = sortMeetingsForGrid(meetings);
        renderMeetingGrid();
        const selected = meetings.find(item => item.id === selectedMeetingId) || null;
        if (!meetingDetails.contains(document.activeElement)) updateMeetingDetails();
        else updateMeetingReadiness(selected);
    }, 30_000);
}

function updateMeetingReadiness(meeting) {
    const draft = meetingContextDrafts.get(meeting?.id) || {};
    const owner = String(meeting?.team || draft.ownerName || '').trim();
    const location = String(meeting?.location || draft.location || '').trim();
    const mode = meeting ? meetingMode(meeting) || draft.mode || '' : '';
    const endedConfirmed = meeting?.state !== 'done' || draft.confirmedEndedMeeting === true;
    const available = Boolean(meeting && meeting.state !== 'cancelled' && meeting.state !== 'invalid'
        && owner && mode && (mode !== 'in_person' || location) && endedConfirmed);
    sendButton.disabled = callSending || !clientConfig?.serviceConfigured
        || (selectedCallType() === 'meeting' && (meetingsLoading || !available));
    return available;
}

function updateMeetingDetails() {
    const meeting = meetings.find(item => item.id === selectedMeetingId) || null;
    renderMeetingDetails(meeting, meetingDetails);
    updateMeetingReadiness(meeting);
}

async function loadMeetings() {
    if (meetingsLoading) return;
    meetingsLoading = true;
    meetingsError = '';
    meetingsState.textContent = 'جاري التحقق من اجتماعات اليوم من المصدر…';
    setCallTypeAvailability();
    $('#refresh-meetings').disabled = true;
    try {
        const payload = await apiRequest('/api/control/meetings');
        setMeetings(payload.meetings || []);
        if (payload.sheetName) meetingsState.textContent = `${meetings.length ? `تم تحميل ${meetings.length} اجتماعات` : 'ما فيه اجتماعات متاحة'} · ${payload.sheetName} · تحديث مباشر`;
    } catch (error) {
        meetings = [];
        selectedMeetingId = '';
        meetingsError = error.status === 502 || error.status === 503
            ? 'ما قدرنا نتحقق من جدول الاجتماعات. النداء للاجتماع متوقف لين يرجع المصدر.'
            : error.message;
        meetingGrid.replaceChildren();
        meetingDetails.hidden = true;
        meetingsState.textContent = meetingsError;
        showResult('تعذر التحقق من الاجتماعات؛ ما تم إرسال أي نداء.', 'error');
    } finally {
        meetingsLoading = false;
        $('#refresh-meetings').disabled = false;
        setCallTypeAvailability();
    }
}

function setBusyDialog(payload) {
    busyDescription.textContent = payload.message || `المهندس ${payload.employee || ''} مرتبط حاليًا باجتماع جارٍ. هل ترغب في إرسال النداء رغم انشغاله؟`;
    busyMeetings.replaceChildren(...(payload.conflicts || []).map(meeting => {
        const card = document.createElement('article');
        card.className = 'busy-meeting';
        const title = document.createElement('h3');
        title.textContent = meeting.project || 'اجتماع';
        const fields = document.createElement('dl');
        const details = [
            ['رقم التذكرة', meeting.project?.match(/AA\d+/i)?.[0] || 'غير موجود في المصدر'],
            ['المهندس المعيّن', meeting.team],
            ['التاريخ', meeting.date],
            ['وقت الاجتماع', `${formatControlTime(meeting.time)} · الرياض`],
            ['النهاية المتوقعة', `${formatControlTime(meeting.expectedEndTime)} · بعد 60 دقيقة`],
            ['نوع الاجتماع', meeting.via],
            ['حالة الاجتماع', meeting.status],
            ['حالة العميل', meeting.clientStatus]
        ];
        for (const [label, value] of details) {
            const cell = document.createElement('div');
            const dt = document.createElement('dt');
            const dd = document.createElement('dd');
            dt.textContent = label;
            dd.textContent = value || 'غير متوفر في المصدر';
            cell.append(dt, dd);
            fields.append(cell);
        }
        const links = document.createElement('div');
        links.className = 'busy-meeting-links';
        const meetLink = safeLink(meeting.meetUrl, 'فتح الاجتماع', 'video');
        const ticketLink = safeLink(meeting.ticketUrl, 'فتح التذكرة', 'external-link');
        if (meetLink) links.append(meetLink);
        if (ticketLink) links.append(ticketLink);
        card.append(title, fields);
        if (links.childElementCount) card.append(links);
        return card;
    }));
    busyConfirmButton.disabled = false;
    showConfirmationDialog(busyDialog, '#cancel-busy');
}

function setDuplicateDialog(payload) {
    duplicateDescription.textContent = payload.message || `تم إرسال نداء إلى ${payload.employee || 'هذا المهندس'} مؤخرًا. هل ترغب في إعادة النداء؟`;
    const callType = payload.previousCallType === 'office' ? 'استدعاء إلى المكتب' : 'استدعاء لدخول اجتماع';
    const ageMs = Math.max(0, Number(payload.ageMs) || 0);
    const age = ageMs < 60_000 ? 'قبل أقل من دقيقة' : `قبل ${Math.floor(ageMs / 60_000)} دقيقة`;
    duplicateDetails.textContent = `${callType} · ${age} · فترة التأكيد دقيقتان`;
    duplicateConfirmButton.disabled = false;
    showConfirmationDialog(duplicateDialog, '#cancel-duplicate');
}

function showConfirmationDialog(dialog, initialFocus) {
    if (busyDialog.hidden && duplicateDialog.hidden) lastFocus = document.activeElement;
    busyDialog.hidden = true;
    duplicateDialog.hidden = true;
    dialog.hidden = false;
    refreshIcons(dialog);
    dialog.querySelector(initialFocus)?.focus();
}

function setConfirmationPending(isPending) {
    for (const button of [busyConfirmButton, busyCancelButton, duplicateConfirmButton, duplicateCancelButton]) {
        button.disabled = isPending;
    }
    const activeDialog = !busyDialog.hidden ? busyDialog : !duplicateDialog.hidden ? duplicateDialog : null;
    for (const dialog of [busyDialog, duplicateDialog]) {
        if (isPending && dialog === activeDialog) dialog.setAttribute('aria-busy', 'true');
        else dialog.removeAttribute('aria-busy');
    }
    if (isPending) activeDialog?.querySelector('[role="alertdialog"]')?.focus();
}

function closeConfirmationDialogs() {
    const hadDialog = !busyDialog.hidden || !duplicateDialog.hidden;
    busyDialog.hidden = true;
    duplicateDialog.hidden = true;
    pendingRequest = null;
    pendingConfirmations = { confirmedBusy: false, confirmedRecentDuplicate: false };
    if (hadDialog) {
        const focusTarget = lastFocus;
        setTimeout(() => {
            if (focusTarget?.isConnected && !focusTarget.disabled && !focusTarget.closest('[hidden]')) {
                focusTarget.focus({ preventScroll: true });
            } else {
                $('#call-result').focus({ preventScroll: true });
            }
        }, 0);
    }
    lastFocus = null;
}

function newCallId() {
    return globalThis.crypto?.randomUUID?.() || `call_${Date.now()}_${Math.random().toString(36).slice(2, 16)}`;
}

async function submitCall() {
    const hasConfirmation = pendingConfirmations.confirmedBusy || pendingConfirmations.confirmedRecentDuplicate;
    if (!pendingRequest || callSending || (sendButton.disabled && !hasConfirmation)) return;
    if (DESIGN_PREVIEW) {
        closeConfirmationDialogs();
        showResult('هذه معاينة تصميمية محلية؛ لم يتم الاتصال بالخادم أو إرسال نداء.', 'warn');
        return;
    }
    callSending = true;
    sendButton.disabled = true;
    setConfirmationPending(true);
    sendButton.classList.add('is-loading');
    sendButton.querySelector('span').textContent = 'جاري التحقق والإرسال…';
    try {
        const result = await apiRequest('/api/control/calls', {
            method: 'POST',
            body: JSON.stringify({ ...pendingRequest, ...pendingConfirmations })
        });
        closeConfirmationDialogs();
        if (result.audioStatus === 'not_configured') {
            showResult('تم إرسال النداء المرئي للشاشة، لكن الصوت يحتاج إعداد GroqCloud على الخادم.', 'warn');
        } else if (result.audioStatus === 'failed') {
            showResult('تم إرسال النداء المرئي للشاشة، لكن تعذّر تجهيز الصوت.', 'warn');
        } else {
            showResult('تم إرسال الأمر للشاشة. ننتظر تأكيد ظهوره وبدء الصوت…');
            void monitorCallStatus(result.eventId, result.audioStatus);
        }
    } catch (error) {
        if (error.payload?.code === 'EMPLOYEE_BUSY' && !pendingConfirmations.confirmedBusy) {
            setBusyDialog(error.payload);
            return;
        }
        if (error.payload?.code === 'RECENT_DUPLICATE_CALL') {
            pendingConfirmations.confirmedRecentDuplicate = false;
            setDuplicateDialog(error.payload);
            return;
        }
        closeConfirmationDialogs();
        showResult(error.message || 'تعذر إرسال النداء، ولم يتم تأكيد الإرسال.', 'error');
    } finally {
        callSending = false;
        sendButton.classList.remove('is-loading');
        sendButton.querySelector('span').textContent = 'إرسال النداء';
        setConfirmationPending(false);
        updateMeetingDetails();
    }
}

async function monitorCallStatus(eventId, audioStatus) {
    if (!eventId || statusTimer) clearTimeout(statusTimer);
    let lastStatus = 'sent';
    for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => { statusTimer = setTimeout(resolve, 1500); });
        try {
            const current = await apiRequest(`/api/control/status?id=${encodeURIComponent(eventId)}`);
            lastStatus = current.status || lastStatus;
            if (current.status === 'audio_started') {
                showResult('وصل النداء إلى الشاشة وبدأ تشغيل الصوت عليها.');
                return;
            }
            if (current.status === 'audio_failed') {
                showResult('ظهر النداء على الشاشة، لكن تشغيل الصوت تعذّر هناك.', 'warn');
                return;
            }
            if (current.status === 'displayed' && ['failed', 'not_configured'].includes(audioStatus)) {
                showResult('ظهر النداء على الشاشة. خدمة الصوت غير مهيأة.', 'warn');
                return;
            }
            if (current.status === 'displayed') showResult('ظهر النداء على الشاشة؛ ننتظر بدء التشغيل الصوتي…');
        } catch { /* Keep the most recent truthful status visible if the board is offline. */ }
    }
    showResult(lastStatus === 'displayed'
        ? 'ظهر النداء على الشاشة، لكن ما تأكد بدء الصوت حتى الآن. راجع حالة الصوت واتصال شاشة العرض.'
        : 'أُرسل الأمر، لكن ما وصلنا تأكيد من شاشة العرض. تحقق من اتصال الشاشة والصوت.', 'warn');
}

async function handleLogin(event) {
    event.preventDefault();
    loginError.hidden = true;
    loginButton.disabled = true;
    loginButton.querySelector('span').textContent = 'جاري التحقق…';
    try {
        const response = await fetch('/api/control/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: String(new FormData(loginForm).get('password') || '') }),
            cache: 'no-store'
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'تعذر تسجيل الدخول. تحقق من كلمة المرور أو حاول لاحقًا.');
        actor = (await apiRequest('/api/control/me')).actor;
        openWorkspace();
    } catch (error) {
        loginError.textContent = error.message || 'تعذر تسجيل الدخول. تحقق من كلمة المرور أو حاول لاحقًا.';
        loginError.hidden = false;
        setConnectionState('تعذر تسجيل الدخول', 'error');
        $('#login-password').focus();
    } finally {
        $('#login-password').value = '';
        loginButton.disabled = false;
        loginButton.querySelector('span').textContent = 'دخول';
    }
}

function setPasswordResult(message, isError = false) {
    passwordResult.hidden = !message;
    passwordResult.textContent = message;
    passwordResult.className = `inline-message${isError ? ' is-error' : ''}`;
}

async function handlePasswordChange(event) {
    event.preventDefault();
    const values = new FormData(passwordForm);
    const currentPassword = String(values.get('currentPassword') || '');
    const newPassword = String(values.get('newPassword') || '');
    const confirmPassword = String(values.get('confirmPassword') || '');
    if (newPassword !== confirmPassword) {
        setPasswordResult('كلمتا المرور الجديدة غير متطابقتين.', true);
        return;
    }
    const button = $('#change-password-submit');
    let passwordWasChanged = false;
    button.disabled = true;
    setPasswordResult('جاري تحديث كلمة المرور وإبطال الجلسات السابقة…');
    try {
        const changed = await apiRequest('/api/control/password', {
            method: 'POST', body: JSON.stringify({ currentPassword, newPassword })
        });
        passwordWasChanged = true;
        if (changed.requiresLogin) {
            document.body.classList.add('is-login');
            appView.hidden = true;
            loginView.hidden = false;
            loginError.textContent = 'تم حفظ التغيير؛ سجّل الدخول بكلمة المرور الجديدة.';
            loginError.hidden = false;
            setPasswordResult('');
            $('#login-password').focus();
            return;
        }
        actor = (await apiRequest('/api/control/me')).actor;
        passwordForm.reset();
        setPasswordResult('تم تغيير كلمة المرور وإبطال كل الجلسات السابقة لهذا المسؤول.');
    } catch (error) {
        if (passwordWasChanged) {
            document.body.classList.add('is-login');
            appView.hidden = true;
            loginView.hidden = false;
            loginError.textContent = 'تم حفظ التغيير؛ سجّل الدخول بكلمة المرور الجديدة.';
            loginError.hidden = false;
            setPasswordResult('');
            $('#login-password').focus();
        } else {
            setPasswordResult(error.message || 'تعذر تغيير كلمة المرور.', true);
        }
    } finally {
        passwordForm.reset();
        button.disabled = false;
    }
}

function openWorkspace() {
    document.body.classList.remove('is-login');
    setupView.hidden = true;
    loginView.hidden = true;
    appView.hidden = false;
    passwordPanel.hidden = true;
    passwordForm.reset();
    $('#role-label').textContent = actor.displayName || actor.roleLabel || '';
    setConnectionState('متصل ومصرّح', 'online');
    const backendNotice = document.getElementById('backend-warning');
    if (!clientConfig.serviceConfigured) {
        backendNotice.hidden = false;
        backendNotice.textContent = 'قاعدة النداءات ما اكتمل إعدادها على الخادم، لذلك الإرسال متوقف حاليًا.';
    }
    if (!clientConfig.speechConfigured) {
        const speech = document.getElementById('speech-warning');
        speech.hidden = false;
        speech.textContent = 'توليد الأصوات الجديدة يحتاج إعداد GroqCloud؛ النداء المرئي يعمل حتى عند تعذر الصوت.';
    }
    renderEmployees();
    setCallTypeAvailability();
    startMeetingStateUpdates();
    if (!DESIGN_PREVIEW && selectedCallType() === 'meeting') void loadMeetings();
}

function previewTime(offsetMinutes, fromNow = getCurrentTimeParts()) {
    const total = Math.max(0, Math.min(23 * 60 + 59, fromNow.hours * 60 + fromNow.minutes + offsetMinutes));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function init() {
    refreshIcons();
    setConnectionState('جاري التحقق من الاتصال', 'pending');
    if (DESIGN_PREVIEW) {
        clientConfig = { serviceConfigured: true, speechConfigured: true };
        actor = {
            roleId: 'business_development_manager',
            roleLabel: 'مدير تطوير الأعمال',
            displayName: 'م. محمد القحطاني',
            permissions: { office: true, meeting: true }
        };
        const today = formatTodayDate();
        const current = getCurrentTimeParts();
        meetings = [
            {
                id: 'preview-running', date: today, time: previewTime(-20, current), project: 'اجتماع متابعة تطبيق أوامر الشبكة AA81747',
                team: 'م. أشرف', via: 'عن بُعد', status: 'قائم', clientStatus: 'مؤكد',
                meetUrl: 'https://meet.google.com/abc-defg-hij', ticketUrl: 'https://aait.sa/odoo/crm/81747'
            },
            {
                id: 'preview-upcoming', date: today, time: previewTime(35, current), project: 'مناقشة خطة تطوير المنصة والخدمات الرقمية',
                team: 'م. محمود', via: 'أونلاين', status: 'قائم', meetUrl: 'https://meet.google.com/abc-defg-hij'
            },
            {
                id: 'preview-inperson', date: today, time: previewTime(75, current), project: 'اجتماع تنسيق مراجعة تجربة العملاء',
                team: 'م. شادي', via: 'حضوري', status: 'قائم'
            },
            {
                id: 'preview-done', date: today, time: previewTime(-80, current), project: 'اجتماع مراجعة التسليم النهائي',
                team: 'م. حسام', via: 'عن بُعد', status: 'تم'
            },
            {
                id: 'preview-cancelled', date: today, time: previewTime(110, current), project: 'اجتماع منقول بانتظار إعادة الجدولة',
                team: 'م. مجاهد', via: 'حضوري', status: 'لم يتم'
            }
        ];
        openWorkspace();
        setMeetings(meetings);
        setConnectionState('معاينة واجهة فقط', 'online');
        if (new URLSearchParams(location.search).get('busy') === '1') {
            pendingRequest = { callId: 'preview_call_001122334455', employeeId: 'ashraf', callType: 'meeting', meetingId: meetings[0].id };
            setBusyDialog({
                employee: 'م. أشرف',
                message: 'المهندس م. أشرف مرتبط حاليًا باجتماع جارٍ. هل ترغب في إرسال النداء رغم انشغاله؟',
                conflicts: [{ ...meetings[0], time: '15:00', expectedEndTime: '16:00', project: 'اجتماع تسليم تطبيق أوامر الشبكة AA81746' }]
            });
        }
        return;
    }
    try {
        const response = await fetch('/api/control/config', { cache: 'no-store' });
        clientConfig = await response.json();
        if (!response.ok) throw new Error(clientConfig.error || 'تعذر تحميل إعدادات النظام');
        if (!clientConfig.firebaseConfigured || !clientConfig.adminsConfigured) {
            showSetup(clientConfig);
            return;
        }
        if (!clientConfig.adminPasswordsConfigured || !clientConfig.rateLimitConfigured || !clientConfig.sessionConfigured) {
            showSetup({ missing: [...new Set([...(clientConfig.missing || []), ...(!clientConfig.adminPasswordsConfigured ? ['CONTROL_ADMIN_PASSWORDS'] : [])])] });
            return;
        }
        setupView.hidden = true;
        loginView.hidden = false;
        document.body.classList.add('is-login');
        try {
            actor = (await apiRequest('/api/control/me')).actor;
            openWorkspace();
            return;
        } catch (error) {
            if (error.status && error.status !== 401) {
                loginError.textContent = 'تعذر التحقق من الجلسة حاليًا. أعد المحاولة بعد قليل.';
                loginError.hidden = false;
                setConnectionState('الخدمة غير متاحة مؤقتًا', 'error');
                return;
            }
        }
        setConnectionState('جاهز للدخول', 'online');
    } catch {
        showSetup({ missing: ['FIREBASE_WEB_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_DATABASE_URL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'CALL_ADMIN_UIDS_JSON', 'CALL_AUTH_RATE_LIMIT_SECRET', 'CALL_AUTH_SESSION_SECRET'] });
    }
}

loginForm.addEventListener('submit', handleLogin);
passwordForm.addEventListener('submit', handlePasswordChange);
callForm.querySelectorAll('input[name="callType"]').forEach(input => input.addEventListener('change', () => {
    clearResult();
    setCallTypeAvailability();
    if (selectedCallType() === 'meeting' && !meetings.length) void loadMeetings();
}));
$('#refresh-meetings').addEventListener('click', () => void loadMeetings());
$('#logout-button').addEventListener('click', async () => {
    if (statusTimer) clearTimeout(statusTimer);
    if (meetingStateInterval) clearInterval(meetingStateInterval);
    let remoteRevoked = false;
    try {
        await apiRequest('/api/control/logout', { method: 'POST' });
        remoteRevoked = true;
    } catch { /* local credentials are cleared even if the server cannot confirm remote revocation */ }
    actor = null;
    meetings = [];
    appView.hidden = true;
    loginView.hidden = false;
    document.body.classList.add('is-login');
    $('#login-password').value = '';
    loginError.textContent = remoteRevoked ? 'تم تسجيل الخروج وإبطال الجلسات السابقة.' : 'تم الخروج من هذا الجهاز، لكن تعذر تأكيد إبطال الجلسات الأخرى.';
    loginError.className = `inline-message${remoteRevoked ? '' : ' is-error'}`;
    loginError.hidden = false;
    setConnectionState(remoteRevoked ? 'تم تسجيل الخروج' : 'تعذر تأكيد إبطال الجلسات', remoteRevoked ? 'pending' : 'error');
    $('#login-password').focus();
});
$('#change-password-toggle').addEventListener('click', () => {
    passwordPanel.hidden = !passwordPanel.hidden;
    if (!passwordPanel.hidden) $('#current-password').focus();
});
$('#change-password-close').addEventListener('click', () => {
    passwordPanel.hidden = true;
    passwordForm.reset();
    setPasswordResult('');
});
callForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!actor) return;
    if (DESIGN_PREVIEW) {
        showResult('هذه معاينة تصميمية محلية؛ ما أُرسل أي نداء.', 'warn');
        return;
    }
    clearResult();
    const callType = selectedCallType();
    const selectedMeeting = meetings.find(item => item.id === selectedMeetingId);
    if (callType === 'meeting' && !selectedMeeting) {
        showResult('اختر اجتماعًا من البطاقات أولًا.', 'error');
        return;
    }
    const draft = selectedMeeting ? meetingContextDrafts.get(selectedMeeting.id) || {} : {};
    if (callType === 'meeting' && selectedMeeting && !updateMeetingReadiness(selectedMeeting)) {
        showResult('أكمل بيانات صاحب الاجتماع ونوعه والموقع إذا كان حضوريًا، وأكّد الاجتماع المنتهي عند الحاجة.', 'error');
        return;
    }
    pendingRequest = createCallRequest({
        callId: newCallId(),
        employeeId: selectedEmployeeId,
        callType,
        meeting: selectedMeeting,
        meetingOwner: selectedMeeting?.team || draft.ownerName,
        meetingLocation: selectedMeeting?.location || draft.location,
        meetingMode: selectedMeeting ? meetingMode(selectedMeeting) || draft.mode : '',
        confirmedEndedMeeting: selectedMeeting?.state === 'done' && draft.confirmedEndedMeeting === true
    });
    pendingConfirmations = { confirmedBusy: false, confirmedRecentDuplicate: false };
    void submitCall();
});
$('#confirm-busy').addEventListener('click', () => {
    if (!pendingRequest) return;
    pendingConfirmations.confirmedBusy = true;
    void submitCall();
});
busyCancelButton.addEventListener('click', closeConfirmationDialogs);
$('#confirm-duplicate').addEventListener('click', () => {
    if (!pendingRequest) return;
    pendingConfirmations.confirmedRecentDuplicate = true;
    void submitCall();
});
duplicateCancelButton.addEventListener('click', closeConfirmationDialogs);
busyDialog.addEventListener('click', event => { if (event.target === busyDialog) closeConfirmationDialogs(); });
duplicateDialog.addEventListener('click', event => { if (event.target === duplicateDialog) closeConfirmationDialogs(); });
document.addEventListener('keydown', event => {
    const activeDialog = !busyDialog.hidden ? busyDialog : !duplicateDialog.hidden ? duplicateDialog : null;
    if (!activeDialog) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeConfirmationDialogs();
    } else if (event.key === 'Tab') {
        const focusable = [...activeDialog.querySelectorAll('button:not(:disabled), a[href]')];
        if (!focusable.length) {
            event.preventDefault();
            activeDialog.querySelector('[role="alertdialog"]')?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

init();
