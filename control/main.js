import './control.css';
import { createIcons, Building2, CalendarDays, Check, CircleUserRound, ExternalLink, Info, KeyRound, LayoutDashboard, Link2, LoaderCircle, LogIn, LogOut, MonitorCheck, PhoneCall, RefreshCw, Send, ShieldAlert, TriangleAlert, UserRoundCheck, UsersRound, Video, X } from 'lucide';

const ICONS = { Building2, CalendarDays, Check, CircleUserRound, ExternalLink, Info, KeyRound, LayoutDashboard, Link2, LoaderCircle, LogIn, LogOut, MonitorCheck, PhoneCall, RefreshCw, Send, ShieldAlert, TriangleAlert, UserRoundCheck, UsersRound, Video, X };
const EMPLOYEES = [
    { id: 'mojahed', name: 'م. مجاهد', color: '#9a78ff' },
    { id: 'mahmoud', name: 'م. محمود', color: '#f6b94a' },
    { id: 'ashraf', name: 'م. أشرف', color: '#3896ff' },
    { id: 'hossam', name: 'م. حسام', color: '#00c98a' },
    { id: 'shady', name: 'م. شادي', color: '#ef5da8' }
];
const ROLE_MEETING_ACCESS = new Set(['business_development_manager', 'deputy_general_manager']);
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
const meetingSelect = $('#meeting-select');
const meetingDetails = $('#meeting-details');
const meetingsState = $('#meetings-state');
const busyDialog = $('#busy-dialog');
const busyDescription = $('#busy-description');
const busyMeetings = $('#busy-meetings');
const busyConfirmButton = $('#confirm-busy');
const displayPairingForm = $('#display-pairing-form');
const displayPairingResult = $('#display-pairing-result');
const displayPairingButton = $('#display-pairing-submit');
const pairedDisplayList = $('#paired-display-list');

let clientConfig = null;
let actor = null;
let meetings = [];
let selectedEmployeeId = EMPLOYEES[0].id;
let pendingRequest = null;
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

async function loadPairedDisplays() {
    if (DESIGN_PREVIEW) return;
    try {
        const result = await apiRequest('/api/control/pairing');
        const count = Number(result.count) || 0;
        pairedDisplayList.textContent = count
            ? `الشاشات المعتمدة: ${count}`
            : 'ما فيه شاشة معتمدة حتى الآن. يظهر رمز الاقتران عند فتح لوحة الاجتماعات على جهاز العرض.';
        if (count) {
            clientConfig.displayConfigured = true;
            if (clientConfig.speechConfigured) $('#speech-warning').hidden = true;
        }
    } catch {
        pairedDisplayList.textContent = 'تعذر تحميل حالة الشاشات المعتمدة.';
    }
}

async function handleDisplayPairing(event) {
    event.preventDefault();
    const input = $('#display-pairing-code');
    const code = String(input.value || '').replace(/\s/g, '');
    displayPairingResult.hidden = true;
    displayPairingButton.disabled = true;
    displayPairingButton.querySelector('span').textContent = 'جارٍ التحقق…';
    try {
        const result = await apiRequest('/api/control/pairing', {
            method: 'POST', body: JSON.stringify({ action: 'approve', code })
        });
        displayPairingResult.textContent = `تم اعتماد شاشة العرض بنجاح (${result.displaySuffix}).`;
        displayPairingResult.className = 'inline-message';
        displayPairingResult.hidden = false;
        input.value = '';
        await loadPairedDisplays();
        if (clientConfig.speechConfigured) {
            const warning = $('#speech-warning');
            warning.hidden = true;
        }
    } catch (error) {
        displayPairingResult.textContent = error.message || 'تعذر اعتماد الشاشة؛ تحقق من الرمز وحاول مجددًا.';
        displayPairingResult.className = 'inline-message is-error';
        displayPairingResult.hidden = false;
    } finally {
        displayPairingButton.disabled = false;
        displayPairingButton.querySelector('span').textContent = 'اعتماد الشاشة';
        input.focus();
    }
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
    const canCallMeeting = ROLE_MEETING_ACCESS.has(actor?.roleId);
    const meetingOption = $('[data-call-option="meeting"]');
    const meetingRadio = meetingOption.querySelector('input');
    meetingRadio.disabled = !canCallMeeting;
    meetingOption.classList.toggle('is-disabled', !canCallMeeting);
    $('#permission-note').hidden = canCallMeeting;
    if (!canCallMeeting) {
        $('#permission-note').textContent = 'حسب صلاحية المدير العام، المتاح هو نداء الحضور إلى المكتب فقط.';
        meetingRadio.checked = false;
        callForm.querySelector('input[name="callType"][value="office"]').checked = true;
    }
    callForm.querySelectorAll('.call-type-option').forEach(option => {
        option.classList.toggle('is-selected', option.querySelector('input').checked);
    });
    $('#meeting-section').hidden = selectedCallType() !== 'meeting';
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
    target.append(
        project,
        createDetail('المهندس المعيّن', meeting.team),
        createDetail('التاريخ والموعد', `${meeting.date} · ${meeting.time || '—'} · الرياض`),
        createDetail('نوع الاجتماع', meeting.via),
        createDetail('الحالة', meeting.status),
        assignment
    );
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

function setMeetingsSelect(nextMeetings) {
    meetings = nextMeetings;
    const options = [new Option('اختر الاجتماع المطلوب', '')];
    for (const meeting of meetings) {
        const time = String(meeting.time || '').slice(0, 5);
        const ticket = meeting.project?.match(/AA\d+/i)?.[0] || '';
        const assigned = meeting.team ? ` · ${meeting.team}` : '';
        options.push(new Option(`${time} · ${meeting.project || 'اجتماع'}${ticket ? ` · ${ticket}` : ''}${assigned}`, meeting.id));
    }
    meetingSelect.replaceChildren(...options);
    meetingSelect.value = meetings[0]?.id || '';
    meetingsState.textContent = meetings.length ? `تم تحميل ${meetings.length} اجتماعات متاحة لليوم.` : 'ما فيه اجتماعات قادمة أو جارية متاحة اليوم.';
    updateMeetingDetails();
}

function updateMeetingDetails() {
    const meeting = meetings.find(item => item.id === meetingSelect.value) || null;
    renderMeetingDetails(meeting, meetingDetails);
    sendButton.disabled = !clientConfig?.serviceConfigured || (selectedCallType() === 'meeting' && !meeting);
}

async function loadMeetings() {
    meetingsState.textContent = 'جاري التحقق من اجتماعات اليوم من المصدر…';
    meetingSelect.disabled = true;
    $('#refresh-meetings').disabled = true;
    try {
        const payload = await apiRequest('/api/control/meetings');
        setMeetingsSelect(payload.meetings || []);
        if (payload.sheetName) meetingsState.textContent = `${meetings.length ? `تم تحميل ${meetings.length} اجتماعات` : 'ما فيه اجتماعات متاحة'} · ${payload.sheetName} · تحديث مباشر`;
    } catch (error) {
        meetings = [];
        meetingSelect.replaceChildren(new Option('تعذر قراءة الاجتماعات', ''));
        meetingDetails.hidden = true;
        meetingsState.textContent = error.status === 502 || error.status === 503
            ? 'ما قدرنا نتحقق من جدول الاجتماعات. النداء للاجتماع متوقف لين يرجع المصدر.'
            : error.message;
        showResult('تعذر التحقق من الاجتماعات؛ ما تم إرسال أي نداء.', 'error');
    } finally {
        meetingSelect.disabled = false;
        $('#refresh-meetings').disabled = false;
        updateMeetingDetails();
        setCallTypeAvailability();
    }
}

function setBusyDialog(payload) {
    lastFocus = document.activeElement;
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
            ['وقت الاجتماع', `${meeting.time || '—'} · الرياض`],
            ['النهاية المتوقعة', `${meeting.expectedEndTime || '—'} · بعد 60 دقيقة`],
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
    busyDialog.hidden = false;
    refreshIcons(busyDialog);
    $('#cancel-busy').focus();
}

function closeBusyDialog() {
    busyDialog.hidden = true;
    pendingRequest = null;
    lastFocus?.focus?.({ preventScroll: true });
}

function newCallId() {
    return globalThis.crypto?.randomUUID?.() || `call_${Date.now()}_${Math.random().toString(36).slice(2, 16)}`;
}

async function submitCall(confirmedBusy = false) {
    if (!pendingRequest || sendButton.disabled) return;
    if (DESIGN_PREVIEW) {
        if (confirmedBusy) closeBusyDialog();
        showResult('هذه معاينة تصميمية محلية؛ لم يتم الاتصال بالخادم أو إرسال نداء.', 'warn');
        pendingRequest = null;
        return;
    }
    sendButton.disabled = true;
    busyConfirmButton.disabled = true;
    sendButton.classList.add('is-loading');
    sendButton.querySelector('span').textContent = 'جاري التحقق والإرسال…';
    try {
        const result = await apiRequest('/api/control/calls', {
            method: 'POST',
            body: JSON.stringify({ ...pendingRequest, confirmedBusy })
        });
        if (confirmedBusy) closeBusyDialog();
        if (result.audioStatus === 'not_configured') {
            showResult('تم إرسال النداء المرئي للشاشة، لكن الصوت يحتاج إعداد GroqCloud على الخادم.', 'warn');
        } else if (result.audioStatus === 'failed') {
            showResult('تم إرسال النداء المرئي للشاشة، لكن تعذّر تجهيز الصوت.', 'warn');
        } else {
            showResult('تم إرسال الأمر للشاشة. ننتظر تأكيد ظهوره وبدء الصوت…');
            void monitorCallStatus(result.eventId, result.audioStatus);
        }
        pendingRequest = null;
    } catch (error) {
        if (error.payload?.code === 'EMPLOYEE_BUSY' && !confirmedBusy) {
            setBusyDialog(error.payload);
            return;
        }
        if (confirmedBusy) closeBusyDialog();
        showResult(error.message || 'تعذر إرسال النداء، ولم يتم تأكيد الإرسال.', 'error');
    } finally {
        sendButton.disabled = false;
        sendButton.classList.remove('is-loading');
        sendButton.querySelector('span').textContent = 'إرسال النداء';
        busyConfirmButton.disabled = false;
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
    $('#role-label').textContent = actor.roleLabel;
    setConnectionState('متصل ومصرّح', 'online');
    const backendNotice = document.getElementById('backend-warning');
    if (!clientConfig.serviceConfigured) {
        backendNotice.hidden = false;
        backendNotice.textContent = 'قاعدة النداءات ما اكتمل إعدادها على الخادم، لذلك الإرسال متوقف حاليًا.';
    }
    if (!clientConfig.speechConfigured || !clientConfig.displayConfigured) {
        const speech = document.getElementById('speech-warning');
        speech.hidden = false;
        speech.textContent = 'توليد الأصوات الجديدة يحتاج إعداد GroqCloud واعتماد هوية شاشة العرض؛ الأصوات المحفوظة على الشاشة تبقى متاحة.';
    }
    renderEmployees();
    void loadPairedDisplays();
    setCallTypeAvailability();
    if (!DESIGN_PREVIEW && selectedCallType() === 'meeting') void loadMeetings();
}

async function init() {
    refreshIcons();
    setConnectionState('جاري التحقق من الاتصال', 'pending');
    if (DESIGN_PREVIEW) {
        clientConfig = { serviceConfigured: true, speechConfigured: true, displayConfigured: true };
        actor = { roleId: 'business_development_manager', roleLabel: 'مدير تطوير الأعمال' };
        meetings = [{
            id: 'preview-meeting-81747',
            date: '2026/10/24',
            time: '15:30',
            expectedEndTime: '16:30',
            project: 'اجتماع متابعة تطبيق أوامر الشبكة AA81747',
            team: 'م. أشرف',
            via: 'عن بعد',
            status: 'قائم',
            clientStatus: 'مؤكد',
            meetUrl: 'https://meet.google.com/abc-defg-hij',
            ticketUrl: 'https://aait.sa/odoo/crm/81747'
        }];
        openWorkspace();
        setMeetingsSelect(meetings);
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
displayPairingForm.addEventListener('submit', handleDisplayPairing);
passwordForm.addEventListener('submit', handlePasswordChange);
callForm.querySelectorAll('input[name="callType"]').forEach(input => input.addEventListener('change', () => {
    clearResult();
    setCallTypeAvailability();
    if (selectedCallType() === 'meeting' && !meetings.length) void loadMeetings();
}));
meetingSelect.addEventListener('change', () => { clearResult(); updateMeetingDetails(); });
$('#refresh-meetings').addEventListener('click', () => void loadMeetings());
$('#logout-button').addEventListener('click', async () => {
    if (statusTimer) clearTimeout(statusTimer);
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
    const selectedMeeting = meetings.find(item => item.id === meetingSelect.value);
    if (callType === 'meeting' && !selectedMeeting) {
        showResult('اختر اجتماعًا من قائمة اجتماعات اليوم أولًا.', 'error');
        return;
    }
    pendingRequest = {
        callId: newCallId(),
        employeeId: selectedEmployeeId,
        callType,
        ...(selectedMeeting ? { meetingId: selectedMeeting.id } : {})
    };
    void submitCall(false);
});
$('#confirm-busy').addEventListener('click', () => {
    if (!pendingRequest) return;
    void submitCall(true);
});
$('#cancel-busy').addEventListener('click', closeBusyDialog);
busyDialog.addEventListener('click', event => { if (event.target === busyDialog) closeBusyDialog(); });
document.addEventListener('keydown', event => {
    if (busyDialog.hidden) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeBusyDialog();
    } else if (event.key === 'Tab') {
        const focusable = [...busyDialog.querySelectorAll('button:not(:disabled), a[href]')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

init();
