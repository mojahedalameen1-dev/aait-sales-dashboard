import '@fontsource/ibm-plex-sans-arabic/300.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './style.css';
import './sidebar.css';
import './meeting-cards.css';
import './call-announcement.css';
import { createPrayerCard, populatePrayerCities } from './prayer-card.js';
import { createRiyadhPrayerAlerts } from './prayer-alerts.js';
import { createPrayerAudioAssetLoader } from './prayer-audio-assets.js';
import { validateIqamaProfile } from './prayer-iqama.js';
import { createCallReceiver } from './call-receiver.js';
import { getPrayerCity } from './prayer-times.js';
import { createDhikrSlider } from './adhkar.js';
import {
    createIcons,
    AlertCircle,
    Bell,
    CalendarCheck2,
    CheckCircle2,
    Clock,
    ChevronLeft,
    ChevronRight,
    CloudOff,
    Info,
    LoaderCircle,
    Leaf,
    MapPin,
    Maximize2,
    Minimize2,
    Moon,
    MoonStar,
    Pause,
    Play,
    RefreshCw,
    Settings,
    Sun,
    Video,
    Volume2,
    VolumeX
} from 'lucide';
import { 
    startAutoSync, 
    fetchMeetings, 
    getSettings, 
    updateSettings, 
    formatTime12h, 
    isDone, 
    isCancelled,
    formatTodayDate,
    getCurrentTimeParts,
    getMeetingTimingState
} from './data.js';
import { 
    startNotificationLoop, 
    requestNotificationPermission,
    unlockAudio,
    setAudioStateListener,
    AUDIO_STATE,
    playTestAlert,
    stopAudioPlayback,
    getNextAudioReminder,
    updateReminderMeetings,
    isAudioPlaybackEnabled,
    playPrayerAnnouncement,
    showToast
} from './notifications.js';
import { 
    escapeHTML, 
    formatMeetingCount,
    getEngineerShortName,
    isSafeMeetingUrl,
    toEnglishDigits
} from './utils.js';
import { APP_TIME_ZONE, getEngineerColor, getEngineerTheme, getEngineerProfile } from './config.js';
import { chooseMeetingGridLayout, getMeetingLayoutMode } from './meeting-layout.js';

// ========================================
// 🌐 State & Constants
// ========================================

let activeMeetings = [];
let activeSyncResult = null;
// BUG-03 tracker
let clockIntervalId = null;
let dynamicUpdateIntervalId = null;
let screenWakeLock = null;
let lastTimingStateSnapshot = '';
let lastGridSignature = null;
let prayerCard = null;
let prayerAlerts = null;
let callReceiver = null;
let pendingPrayerReminder = null;
let pendingPrayerReminderTimeout = null;
let prayerAlertStatusTimeout = null;
let dhikrSlider = null;
let currentAudioState = AUDIO_STATE.LOCKED;
const loadPrayerAudioAsset = createPrayerAudioAssetLoader();
const IQAMA_PRAYER_KEYS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
let meetingGridResizeObserver = null;
let meetingGridResizeFrame = 0;
let meetingDetailsDialog = null;

function getLayoutPreviewMeetings() {
    if (!import.meta.env.DEV) return null;
    const count = Number(new URLSearchParams(window.location.search).get('layoutPreview'));
    if (![9, 20, 35, 50].includes(count)) return null;

    const clients = ['البلدية الشرقية', 'عبد العزيز للتطبيقات', 'أسامة غرم الله', 'شركة المدى', 'مركز المعرفة', 'مجموعة النور', 'نقل وتركي', 'مؤسسة البناء', 'مبيعات الخليج', 'أكاديمية المستقبل'];
    const projects = ['تطوير النظام', 'تحسين تجربة العميل', 'أتمتة إجراءات العمل', 'تطبيق إدارة الطلبات', 'تحديث المنصة الرقمية', 'ربط أنظمة التشغيل', 'لوحة متابعة الأداء', 'تجهيز عرض الخدمات'];
    const teams = ['شادي', 'أشرف', 'مجاهد', 'حسام'];
    const today = formatTodayDate();

    return Array.from({ length: count }, (_, index) => {
        const ticket = `AA${837500 + index}`;
        const hour = 8 + Math.floor(index * 10 / Math.max(1, count - 1));
        const minute = index % 2 ? '30' : '00';
        return {
            id: `layout-preview-${index + 1}`,
            date: today,
            time: `${String(hour).padStart(2, '0')}:${minute}`,
            project: `${clients[index % clients.length]} - ${projects[(index * 3) % projects.length]} ${index + 1} - ${ticket}`,
            team: teams[index % teams.length],
            via: index % 4 === 0 ? 'حضوري' : 'عن بعد',
            status: index % 11 === 0 ? 'تم' : index % 17 === 0 ? 'ملغي' : '',
            ticketUrl: `https://e.aait.sa/web#id=${837500 + index}&model=crm.lead&view_type=form`,
            meetUrl: index % 4 === 0 ? '' : `https://meet.google.com/aaa-bbbb-${String(index + 1).padStart(3, '0')}`,
            clientStatus: index % 3 === 0 ? 'مهتم' : 'قيد المتابعة'
        };
    });
}

function refreshIcons(root = document) {
    createIcons({
        root,
        icons: {
            AlertCircle,
            Bell,
            CalendarCheck2,
            CheckCircle2,
            Clock,
            ChevronLeft,
            ChevronRight,
            CloudOff,
            Info,
            LoaderCircle,
            Leaf,
            MapPin,
            Maximize2,
            Minimize2,
            Moon,
            MoonStar,
            Pause,
            Play,
            RefreshCw,
            Settings,
            Sun,
            Video,
            Volume2,
            VolumeX
        }
    });
    root.querySelectorAll('svg[data-lucide]').forEach(icon => icon.removeAttribute('data-lucide'));
}

// ========================================
// ⏰ Utilities
// ========================================

const safeDisplayText = value => escapeHTML(toEnglishDigits(value));

// ⚠️ NOTE: Engineer name matching is also handled in utils.js → getEngineerShortName()
// If you add or rename an engineer, update BOTH functions.
function getDeveloperGradient(team) {
    const color = getEngineerColor(team);
    return `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 68%, #08111f))`;
}

function getMeetingDisplay(meeting) {
    const project = toEnglishDigits(meeting?.project || '');
    const ticketNum = project.match(/AA\d+/i)?.[0]?.toUpperCase() || '';
    const typeKeywords = /عن\s+بعد|اون\s*لاين|أون\s*لاين|online|remote|حضوري|خارجي|زيارة|مكتب|مقر/gi;
    const cleaned = project
        .replace(ticketNum, '')
        .replace(typeKeywords, '')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/^[\s\-–—:،.]+|[\s\-–—:،.]+$/g, '')
        .trim();
    const parts = cleaned.split(/\s+-\s+|\s{2,}|[_|]+/).map(part => part.replace(/[()\[\]{}]/g, '').trim()).filter(Boolean);
    const vagueTitle = /^(?:غير\s*محدد|اجتماع(?:\s*[اأإآ])?|عميل|تطبيق|[-—])$/i;
    let client = parts[0] || '';
    if (!client || vagueTitle.test(client)) client = 'اجتماع عميل';
    return { client, projectDesc: parts.slice(1).join(' ').trim(), ticketNum };
}

function getRelativeMeetingLabel(timing) {
    if (timing.state === 'running') return `بدأ منذ ${Math.max(1, Math.floor(Math.abs(timing.minutesUntil)))} دقيقة`;
    if (timing.state !== 'upcoming') return '';
    const minutes = Math.max(1, Math.ceil(timing.minutesUntil));
    if (minutes < 60) return `بعد ${minutes} دقيقة`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `بعد ${hours} س و${remainder} د` : `بعد ${hours} ساعة`;
}

function getMeetingProgress(timing) {
    if (timing.state === 'running') {
        return Math.min(100, Math.max(4, (Math.abs(timing.minutesUntil) / timing.duration) * 100));
    }
    if (timing.state === 'upcoming' && timing.minutesUntil <= 60) {
        return Math.min(100, Math.max(0, ((60 - timing.minutesUntil) / 60) * 100));
    }
    return 0;
}

// ========================================
// 🎨 Rendering Logic
// ========================================

/**
 * Safely get or update text content of an element by ID
 */
function setSafeText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = toEnglishDigits(text);
}

function animateCount(id, targetValue, duration = 1500) {
    const el = document.getElementById(id);
    if (!el) return;
    const start = parseInt(el.textContent) || 0;
    const target = parseInt(targetValue) || 0;
    if (start === target) return;
    
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (target - start) * eased);
        el.textContent = current;
        if (progress < 1) requestAnimationFrame(update);
    }
    
    requestAnimationFrame(update);
}

function updateDaySummary(meetings) {
    const summary = document.getElementById('day-summary');
    if (!summary) return;
    const hour = getCurrentTimeParts(new Date()).hours;
    const greeting = hour < 12 ? 'صباح الخير' : hour < 18 ? 'مساء الخير' : 'مساء النور';
    summary.textContent = meetings.length
        ? `${greeting}، عندك ${formatMeetingCount(meetings.length)} اليوم`
        : `${greeting}، جدولك هادئ اليوم`;
}

function updatePressureSummary(meetings) {
    const summary = document.getElementById('pressure-summary');
    const text = summary?.querySelector('span');
    if (!summary || !text) return;

    const active = meetings
        .map(meeting => ({ meeting, timing: getMeetingTimingState(meeting) }))
        .filter(item => ['upcoming', 'running'].includes(item.timing.state));
    const engineerMeetings = new Map();

    for (const item of active) {
        const profile = getEngineerProfile(item.meeting.team);
        const key = profile?.id || String(item.meeting.team || '').trim().toLocaleLowerCase();
        if (!key) continue;
        const group = engineerMeetings.get(key) || [];
        group.push(item);
        engineerMeetings.set(key, group);
    }

    let peak = { count: 1, startMinutes: 0 };
    for (const items of engineerMeetings.values()) {
        const events = items.flatMap(item => [
            { minute: item.timing.startMinutes, delta: 1 },
            { minute: item.timing.endMinutes, delta: -1 }
        ]).sort((a, b) => a.minute - b.minute || a.delta - b.delta);
        let count = 0;
        for (const event of events) {
            count += event.delta;
            if (count > peak.count) peak = { count, startMinutes: event.minute };
        }
    }

    const hasPressure = peak.count > 1;
    summary.classList.toggle('has-pressure', hasPressure);
    text.textContent = hasPressure
        ? `تعارض محتمل: ${peak.count} اجتماعات للمهندس نفسه قرب ${formatTime12h(`${String(Math.floor(peak.startMinutes / 60)).padStart(2, '0')}:${String(peak.startMinutes % 60).padStart(2, '0')}`)}`
        : 'لا توجد اجتماعات متداخلة للمهندس نفسه';
}

function applyMeetingGridLayout(grid, count) {
    const mode = getMeetingLayoutMode(count);
    grid.classList.remove('layout-normal', 'layout-compact', 'layout-ultra', 'has-many-meetings');
    grid.classList.add(`layout-${mode}`);

    const styles = getComputedStyle(grid);
    const width = Math.max(0, grid.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight));
    const height = Math.max(0, grid.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom));
    const layout = chooseMeetingGridLayout({ count, width, height, mode });

    grid.style.setProperty('--meeting-columns', String(layout.columns));
    grid.style.setProperty('--meeting-rows', String(layout.rows));
    grid.dataset.layoutMode = layout.mode;
    grid.dataset.layoutColumns = String(layout.columns);
    grid.dataset.layoutRows = String(layout.rows);
    grid.dataset.layoutCardWidth = String(Math.round(layout.cardWidth));
    grid.dataset.layoutCardHeight = String(Math.round(layout.cardHeight));
    grid.dataset.layoutFits = String(layout.fits);
    return layout;
}

function scheduleMeetingGridLayout() {
    if (meetingGridResizeFrame) cancelAnimationFrame(meetingGridResizeFrame);
    meetingGridResizeFrame = requestAnimationFrame(() => {
        meetingGridResizeFrame = 0;
        const grid = document.getElementById('meetings-grid');
        if (grid) applyMeetingGridLayout(grid, grid.querySelectorAll('.meeting-card').length);
    });
}

function setupMeetingGridResponsiveLayout(grid) {
    meetingGridResizeObserver?.disconnect();
    if ('ResizeObserver' in window) {
        meetingGridResizeObserver = new ResizeObserver(scheduleMeetingGridLayout);
        meetingGridResizeObserver.observe(grid);
        const mainContent = document.querySelector('.main-content');
        if (mainContent) meetingGridResizeObserver.observe(mainContent);
    }
    window.addEventListener('resize', scheduleMeetingGridLayout, { passive: true });
    document.addEventListener('fullscreenchange', scheduleMeetingGridLayout);
    document.fonts?.ready?.then(scheduleMeetingGridLayout);

    grid.addEventListener('click', event => {
        const card = event.target.closest('.meeting-card.is-ultra-card');
        if (!card || !grid.contains(card)) return;
        openMeetingDetails(activeMeetings.find(meeting => String(meeting.id) === card.dataset.meetingId));
    });
    grid.addEventListener('keydown', event => {
        const card = event.target.closest('.meeting-card.is-ultra-card');
        if (!card || event.target !== card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        openMeetingDetails(activeMeetings.find(meeting => String(meeting.id) === card.dataset.meetingId));
    });
}

function openMeetingDetails(meeting) {
    if (!meeting) return;
    if (!meetingDetailsDialog) {
        meetingDetailsDialog = document.createElement('dialog');
        meetingDetailsDialog.className = 'meeting-details-dialog';
        meetingDetailsDialog.setAttribute('aria-labelledby', 'meeting-details-title');
        meetingDetailsDialog.innerHTML = `
            <div class="meeting-details-panel">
              <header class="meeting-details-heading">
                <div><span>تفاصيل الاجتماع</span><h2 id="meeting-details-title"></h2></div>
                <button class="meeting-details-close" type="button" aria-label="إغلاق التفاصيل">×</button>
              </header>
              <dl class="meeting-details-list">
                <div><dt>المسؤول</dt><dd data-meeting-field="team"></dd></div>
                <div><dt>الوقت</dt><dd data-meeting-field="time"></dd></div>
                <div><dt>الطريقة</dt><dd data-meeting-field="via"></dd></div>
                <div><dt>الحالة</dt><dd data-meeting-field="status"></dd></div>
                <div><dt>حالة العميل</dt><dd data-meeting-field="clientStatus"></dd></div>
              </dl>
              <div class="meeting-details-actions"></div>
            </div>`;
        meetingDetailsDialog.querySelector('.meeting-details-close').addEventListener('click', () => meetingDetailsDialog.close());
        meetingDetailsDialog.addEventListener('click', event => {
            if (event.target === meetingDetailsDialog) meetingDetailsDialog.close();
        });
        document.body.appendChild(meetingDetailsDialog);
    }

    const projectTitle = meeting.project || 'اجتماع عميل';
    meetingDetailsDialog.querySelector('#meeting-details-title').textContent = projectTitle;
    meetingDetailsDialog.querySelector('[data-meeting-field="team"]').textContent = meeting.team || 'غير محدد';
    meetingDetailsDialog.querySelector('[data-meeting-field="time"]').textContent = formatTime12h(meeting.time);
    meetingDetailsDialog.querySelector('[data-meeting-field="via"]').textContent = meeting.via || 'غير محدد';
    meetingDetailsDialog.querySelector('[data-meeting-field="status"]').textContent = meeting.status || 'قادم';
    meetingDetailsDialog.querySelector('[data-meeting-field="clientStatus"]').textContent = meeting.clientStatus || 'غير محدد';

    const actions = meetingDetailsDialog.querySelector('.meeting-details-actions');
    actions.replaceChildren();
    for (const link of [
        { label: 'فتح التذكرة', url: meeting.ticketUrl },
        { label: 'دخول الاجتماع', url: meeting.meetUrl }
    ]) {
        if (!isSafeMeetingUrl(link.url)) continue;
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = link.label;
        actions.appendChild(anchor);
    }

    meetingDetailsDialog.showModal();
}

function renderUI(meetings) {
    const grid = document.getElementById('meetings-grid');
    if (!grid) {
        console.error('Missing #meetings-grid');
        return;
    }

    const today = formatTodayDate();
    const todayMeetings = meetings.filter(m => m.date === today);

    // Update Stats (Arabic Grammar)
    const meetingStates = todayMeetings.map(meeting => ({ meeting, timing: getMeetingTimingState(meeting) }));
    lastTimingStateSnapshot = meetingStates.map(item => `${item.meeting.id}:${item.timing.state}`).join('|');
    const runningNow = meetingStates.filter(item => item.timing.state === 'running');
    const upcoming = meetingStates.filter(item => item.timing.state === 'upcoming');

    animateCount('stat-total', todayMeetings.length);
    animateCount('stat-done', todayMeetings.filter(m => isDone(m)).length);
    animateCount('stat-pending', upcoming.length);
    animateCount('stat-urgent', runningNow.length);
    updateDaySummary(todayMeetings);
    updatePressureSummary(todayMeetings);

    // Sorting: Pending First, then Done, then Cancelled
    const sorted = [...todayMeetings].sort((a, b) => {
        const aDone = isDone(a) || isCancelled(a);
        const bDone = isDone(b) || isCancelled(b);
        if (aDone && !bDone) return 1;
        if (!aDone && bDone) return -1;
        return (a.time || '').localeCompare(b.time || '');
    });
    const layoutMode = getMeetingLayoutMode(sorted.length);
    grid.classList.remove('layout-normal', 'layout-compact', 'layout-ultra', 'has-many-meetings');
    grid.classList.add(`layout-${layoutMode}`);
    applyMeetingGridLayout(grid, sorted.length);

    const gridSignature = JSON.stringify({
        error: activeSyncResult?.error || '',
        stale: Boolean(activeSyncResult?.stale),
        meetings: sorted.map(meeting => [
            meeting.id, meeting.date, meeting.time, meeting.project, meeting.team, meeting.via,
            meeting.status, meeting.ticketUrl, meeting.meetUrl, meeting.clientStatus,
            getMeetingTimingState(meeting).state
        ])
    });
    if (gridSignature === lastGridSignature) {
        updateDynamicState();
        return;
    }
    lastGridSignature = gridSignature;

    if (sorted.length === 0) {
        renderEmptyState(grid);
        refreshIcons();
        updateDynamicState();
        return;
    }

    grid.innerHTML = sorted.map(m => {
        const done = isDone(m);
        const cancelled = isCancelled(m);
        const timing = getMeetingTimingState(m);
        const timingState = timing.state;
        const gradient = getDeveloperGradient(m.team);
        const engineerTheme = getEngineerTheme(m.team);
        const { client, projectDesc, ticketNum } = getMeetingDisplay(m);
        
        // Meeting Type Classification (Sourced ONLY from m.via)
        let meetingType = (m.via || '').trim();
        let typeClass = 'type-online';
        if (/حضوري|مكتب|مقر/i.test(meetingType)) typeClass = 'type-office';
        else if (/خارجي|زيارة|عميل/i.test(meetingType)) typeClass = 'type-external';

        const isOnline = /بعد|remote|zoom|google meet|online|اون لاين/i.test(meetingType);
        const hasSafeMeetingUrl = isOnline && isSafeMeetingUrl(m.meetUrl);
        const hasSafeTicketUrl = isSafeMeetingUrl(m.ticketUrl);
        const engineerLabel = getEngineerShortName(m.team);
        const isUltraLayout = layoutMode === 'ultra';
        const ultraTitle = [client, projectDesc].filter(Boolean).join(' — ') || client;
        const startsSoon = timingState === 'upcoming' && timing.minutesUntil <= 10;
        const normalizedStatus = String(m.status || '')
            .replace(/[أإآ]/g, 'ا')
            .replace(/ؤ/g, 'و')
            .replace(/ئ/g, 'ي')
            .replace(/[\u064B-\u065F\u0670]/g, '')
            .trim()
            .toLowerCase();
        const cancelledStatusMeta = /^لم\s*(?:يتم|تتم)$/.test(normalizedStatus)
            ? { label: 'لم يتم', className: 'is-not-done', icon: 'info' }
            : /موجل|موجلة|تاجيل|postponed/.test(normalizedStatus)
                ? { label: 'مؤجل', className: 'is-cancelled', icon: 'info' }
                : { label: 'ملغي', className: 'is-cancelled', icon: 'info' };
        const statusMeta = done
            ? { label: 'منتهي', className: 'is-done', icon: 'check-circle-2' }
            : cancelled
                ? cancelledStatusMeta
                : timingState === 'running'
                    ? { label: `جارٍ الآن · منذ ${Math.max(0, Math.abs(timing.minutesUntil))} د`, className: 'is-running', icon: 'loader-circle' }
                    : timingState === 'overdue'
                        ? { label: 'يحتاج متابعة', className: 'is-overdue', icon: 'alert-circle' }
                        : startsSoon
                            ? { label: 'يبدأ قريباً', className: 'is-soon', icon: 'alert-circle' }
                            : { label: 'قادم', className: 'is-upcoming', icon: 'clock' };
        const relativeLabel = getRelativeMeetingLabel(timing);
        const progress = getMeetingProgress(timing);
        const joinLabel = timingState === 'running' ? 'ادخل الآن' : startsSoon ? 'دخول الاجتماع' : 'الرابط';
        const noLinkLabel = !meetingType ? 'الطريقة غير محددة' : isOnline ? 'لا يوجد رابط' : 'حضوري';

        return `
            <article class="meeting-card ${done ? 'completed' : ''} ${cancelled ? 'cancelled' : ''} ${isUltraLayout ? 'is-ultra-card' : ''}
                 ${timingState === 'running' ? 'current' : ''} ${timingState === 'overdue' ? 'overdue' : ''}
                 ${engineerTheme !== 'default' ? `theme-${engineerTheme}` : ''}"
                 style="background: ${gradient}" data-meeting-id="${escapeHTML(String(m.id))}"
                 ${isUltraLayout ? `role="button" tabindex="0" aria-haspopup="dialog" aria-label="عرض تفاصيل الاجتماع: ${safeDisplayText(ultraTitle)}"` : 'tabindex="-1"'}>
              <div class="card-bg-pattern"></div>
              <header class="mc-header">
              ${isUltraLayout || timingState !== 'running'
                ? `<div class="mc-status ${statusMeta.className}" title="${safeDisplayText(statusMeta.label)}" aria-label="الحالة: ${safeDisplayText(statusMeta.label)}"><i data-lucide="${statusMeta.icon}"></i><span>${statusMeta.label}</span></div>`
                : ''}

              ${hasSafeMeetingUrl ? `
                ${isUltraLayout
                    ? `<span class="mc-quick-join" aria-hidden="true"><i data-lucide="video"></i></span>`
                    : `<a href="${escapeHTML(m.meetUrl)}" target="_blank" rel="noopener noreferrer" class="mc-quick-join" aria-label="الانضمام إلى اجتماع ${escapeHTML(client)}"><i data-lucide="video"></i><span>${joinLabel}</span></a>`}
              ` : `<div class="mc-location-state ${isOnline ? 'missing-link' : ''}">${noLinkLabel}</div>`}
              </header>

              <div class="card-content">
                <div class="mc-details">
                  ${isUltraLayout ? `<div class="mc-ultra-title" title="${safeDisplayText(ultraTitle)}">${safeDisplayText(ultraTitle)}</div>` : ''}
                  <div class="mc-client" title="${safeDisplayText(client)}">${safeDisplayText(client)}</div>
                  <div class="mc-engineer" title="مع ${safeDisplayText(engineerLabel)}"><span class="mc-engineer-prefix">مع </span><span class="mc-engineer-name">${safeDisplayText(engineerLabel)}</span></div>
                  ${projectDesc ? `<div class="mc-project-desc" title="${safeDisplayText(projectDesc)}">${safeDisplayText(projectDesc)}</div>` : ''}
                  <div class="mc-meta">
                    ${meetingType ? `<div class="mc-type-badge ${typeClass}" title="${safeDisplayText(meetingType)}">${safeDisplayText(meetingType)}</div>` : ''}
                    ${ticketNum ? (isUltraLayout
                        ? `<span class="mc-ticket-pill">${ticketNum}</span>`
                        : hasSafeTicketUrl
                        ? `<a class="mc-ticket-pill is-link" href="${escapeHTML(m.ticketUrl)}" target="_blank" rel="noopener noreferrer" aria-label="فتح التذكرة ${ticketNum}">${ticketNum}</a>`
                        : `<div class="mc-ticket-pill">${ticketNum}</div>`) : ''}
                  </div>
                </div>

                <footer class="mc-footer">
                  ${relativeLabel ? `<div class="mc-relative">${relativeLabel}</div>` : ''}
                  <div class="mc-time">
                    <i data-lucide="clock"></i>
                    <span class="en-nums">${formatTime12h(m.time)}</span>
                  </div>
                </footer>
              </div>

              <div class="mc-progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></div>

            </article>
        `;
    }).join('');

    refreshIcons();


    updateDynamicState();
}

function updateLiveMeetingState() {
    const today = formatTodayDate();
    const snapshot = activeMeetings
        .filter(meeting => meeting.date === today)
        .map(meeting => `${meeting.id}:${getMeetingTimingState(meeting).state}`)
        .join('|');

    if (snapshot !== lastTimingStateSnapshot) {
        renderUI(activeMeetings);
        return;
    }
    updateDynamicState();
}

function renderEmptyState(grid) {
    const hasError = Boolean(activeSyncResult?.error);
    const hasCache = Boolean(activeSyncResult?.hasCache);
    const title = hasError
        ? 'تعذر تحديث اجتماعات اليوم'
        : 'لا توجد اجتماعات مسجلة اليوم';
    const message = hasError
        ? (hasCache ? 'نعرض آخر نسخة محفوظة، وسيُعاد المحاولة تلقائيًا.' : 'تحقق من نشر تبويب الشهر أو الاتصال بمصدر البيانات.')
        : `تمت مراجعة تبويب ${activeSyncResult?.sheetName || 'الشهر الحالي'} ولا توجد اجتماعات لهذا اليوم.`;

    grid.innerHTML = `
        <div class="empty-state ${hasError ? 'has-error' : ''}">
            <i data-lucide="${hasError ? 'cloud-off' : 'calendar-check-2'}"></i>
            <h2>${title}</h2>
            <p>${escapeHTML(message)}</p>
            ${hasError ? '<button class="btn-prime" id="empty-retry-btn" type="button">إعادة المحاولة</button>' : ''}
        </div>
    `;
    document.getElementById('empty-retry-btn')?.addEventListener('click', window.manualRefresh);
}

// ========================================
// ⏰ Clock & Countdown
// ========================================

function startClock() {
    if (clockIntervalId) clearInterval(clockIntervalId);
    const tick = () => {
        const now = new Date();
        prayerCard?.tick(now);
        prayerAlerts?.tick(now);
        const timeParts = getCurrentTimeParts(now);
        let h = timeParts.hours;
        const m = String(timeParts.minutes).padStart(2, '0');
        const suffix = h < 12 ? 'ص' : 'م';
        h = h % 12 || 12;

        setSafeText('live-clock', `${h}:${m} ${suffix}`);

        const dateStr = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
            timeZone: APP_TIME_ZONE,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        }).format(now);
        setSafeText('live-date', dateStr);
        if (timeParts.seconds % 30 === 0) updateSyncAge();
    };
    tick();
    clockIntervalId = setInterval(tick, 1000);
}

function updateCountdown(meeting) {
    const timer = document.getElementById('countdown-timer');
    const label = document.querySelector('.countdown-label');
    const countdownContainer = document.querySelector('.next-meeting-countdown');
    const caption = document.getElementById('countdown-caption');

    if (!timer || !label || !countdownContainer) return;

    if (!meeting) {
        timer.textContent = "00:00";
        timer.style.display = 'block';
        label.textContent = "لا اجتماعات متبقية اليوم";
        countdownContainer.classList.remove('urgent');
        if (caption) caption.hidden = true;
        return;
    }

    const timing = getMeetingTimingState(meeting);
    const diff = timing.minutesUntil * 60000;

    // Urgency handling (< 5 mins)
    if (diff > 0 && diff < 5 * 60000) {
        countdownContainer.classList.add('urgent');
        timer.style.color = 'var(--color-urgent)';
    } else {
        countdownContainer.classList.remove('urgent');
        timer.style.color = 'var(--text-white)';
    }

    if (timing.state === 'running') {
        label.textContent = 'المتبقي للاجتماع الجاري';
        timer.style.display = 'block';
        timer.textContent = formatDuration(Math.max(0, timing.duration * 60 + timing.minutesUntil * 60));
        if (caption) { caption.hidden = false; caption.textContent = 'دقيقة : ثانية'; }
    } else {
        label.textContent = timing.minutesUntil <= 5 ? 'يبدأ الاجتماع قريباً' : 'الاجتماع التالي';
        timer.style.display = 'block';
        if (caption) {
            caption.hidden = false;
            caption.textContent = timing.minutesUntil >= 60 ? 'ساعة : دقيقة : ثانية' : 'دقيقة : ثانية';
        }
        const hours = Math.floor(diff / 3600000);
        const mm = Math.floor((diff % 3600000) / 60000);
        const ss = Math.floor((diff % 60000) / 1000);

        let timeStr = "";
        if (hours > 0) {
            timeStr = `${hours}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        } else {
            timeStr = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        }
        timer.textContent = toEnglishDigits(timeStr);
    }

    // Automated Aurora Intensity & Position
    const intensity = (diff > 0 && diff < 5 * 60000) ? 0.25 : 0.12;
    const pos = (diff > 0 && diff < 5 * 60000) ? '50% 10%' : '50% 30%';
    document.documentElement.style.setProperty('--aurora-intensity', intensity);
    document.documentElement.style.setProperty('--aurora-pos', pos);
}

function updateDynamicState() {
    updateVoiceReminderStatus();
    if (!activeMeetings || !activeMeetings.length) {
        updateCountdown(null);
        return;
    }

    const today = formatTodayDate();
    const filtered = activeMeetings.filter(m => m.date === today && !isCancelled(m));
    
    const pending = filtered
        .filter(m => !isDone(m))
        .map(m => ({ m, timing: getMeetingTimingState(m) }))
        .filter(item => ['running', 'upcoming'].includes(item.timing.state));

    // Keep the next countdown visible even while another meeting is running.
    const upcoming = pending
        .filter(item => item.timing.state === 'upcoming')
        .sort((a, b) => a.timing.minutesUntil - b.timing.minutesUntil);
    const running = pending
        .filter(item => item.timing.state === 'running')
        .sort((a, b) => b.timing.startMinutes - a.timing.startMinutes);

    const match = upcoming[0] || running[0] || null;
    const current = match?.m || null;

    // Aurora Color Mapping
    const auroraColor = current ? getEngineerColor(current.team) : '#2962FF';
    document.documentElement.style.setProperty('--aurora-color', `${auroraColor}22`);

    // Overlapping meetings detection (diff < 5 mins)
    updateCountdown(current);
}

function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const secs = safeSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateVoiceReminderStatus() {
    const container = document.getElementById('voice-reminder-status');
    const text = container?.querySelector('span');
    if (!container || !text) return;

    const reminder = getNextAudioReminder(activeMeetings, formatTodayDate());
    container.classList.toggle('is-muted', reminder.state === 'muted');
    container.classList.toggle('is-due', reminder.state === 'scheduled' && reminder.secondsUntil === 0);

    if (reminder.state === 'muted') {
        text.textContent = 'النداء الصوتي متوقف';
    } else if (reminder.state === 'scheduled') {
        const alertLabel = 'تذكير الاجتماع';
        text.textContent = reminder.secondsUntil === 0
            ? `${alertLabel} مستحق الآن`
            : `${alertLabel} بعد ${formatDuration(reminder.secondsUntil)}`;
    } else {
        text.textContent = 'لا يوجد نداء صوتي متبقٍ اليوم';
    }
}

// ========================================
// 🔘 UI Handlers
// ========================================

function updateSyncStatus(result, isLoading = false) {
    const container = document.getElementById('sync-warning');
    if (!container) return;
    const failed = Boolean(result?.stale || result?.error || result?.fromCache);
    if (isLoading) return; // Keep a real failure visible while retrying.
    container.hidden = !failed;
    container.dataset.lastSync = result?.lastSync || '';
    container.dataset.syncError = !failed ? '' : result?.lastSync
        ? 'تعذر تحديث الاجتماعات؛ نعرض آخر نسخة محفوظة.'
        : 'تعذر تحميل الاجتماعات؛ تحقق من الاتصال وأعد التحديث.';
    if (failed) updateSyncAge();
}

function updateSyncAge() {
    const container = document.getElementById('sync-warning');
    const text = container?.querySelector('span');
    if (!container || container.hidden || !text) return;
    text.textContent = [container.dataset.syncError, formatSyncAge(container.dataset.lastSync)].filter(Boolean).join(' ');
}

function setModalBackgroundInert(modal, inert) {
    for (const element of document.body.children) {
        if (element === modal) continue;
        if (inert) {
            if (!element.hasAttribute('data-modal-inert-previous')) {
                element.setAttribute('data-modal-inert-previous', String(element.inert));
            }
            element.inert = true;
        } else if (element.hasAttribute('data-modal-inert-previous')) {
            element.inert = element.getAttribute('data-modal-inert-previous') === 'true';
            element.removeAttribute('data-modal-inert-previous');
        }
    }
}

function trapDialogFocus(event, dialog) {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
        event.preventDefault();
        dialog.querySelector('[tabindex="-1"]')?.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}

function formatSyncAge(lastSync) {
    if (!lastSync) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(lastSync).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return 'وقت آخر تحديث غير معروف';
    const age = seconds < 45 ? 'الآن' : seconds < 3600 ? `منذ ${Math.floor(seconds / 60)} دقيقة` : `منذ ${Math.floor(seconds / 3600)} ساعة`;
    return `آخر بيانات ناجحة ${age}`;
}

function setControlFeedback(button, message, kind = 'success') {
    if (!button) return;
    const original = button.dataset.tooltip;
    button.dataset.tooltip = message;
    button.title = message;
    button.classList.toggle('is-success', kind === 'success');
    button.classList.toggle('is-error', kind === 'error');
    setTimeout(() => {
        button.dataset.tooltip = original;
        button.title = original;
        button.classList.remove('is-success', 'is-error');
    }, 1800);
}

window.manualRefresh = async () => {
    if (window._isManualRefreshing) return;
    window._isManualRefreshing = true;

    const btn = document.getElementById('refresh-now-btn');
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    }
    updateSyncStatus(activeSyncResult, true);

    try {
        const result = await fetchMeetings();
        activeSyncResult = result;
        activeMeetings = result.meetings;
        updateReminderMeetings(activeMeetings);
        updateSyncStatus(result);
        renderUI(activeMeetings);
    } catch (error) {
        activeSyncResult = {
            ...(activeSyncResult || {}),
            meetings: activeMeetings,
            stale: true,
            error: error?.message || 'تعذر تحديث البيانات'
        };
        updateSyncStatus(activeSyncResult);
    } finally {
        window._isManualRefreshing = false;
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            const failed = Boolean(activeSyncResult?.error || activeSyncResult?.stale);
            setControlFeedback(btn, failed ? 'لم يكتمل التحديث' : 'تم التحديث', failed ? 'error' : 'success');
        }
    }
};

window.toggleTheme = () => {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    // Important: Query for i OR svg because Lucide replaces them
    const icon = document.querySelector('#theme-toggle-btn i, #theme-toggle-btn svg');
    if (icon) {
        icon.setAttribute('data-lucide', isLight ? 'sun' : 'moon');
        refreshIcons();
    }
};

window.toggleSound = () => {
    const soundEnabled = !getSettings().soundEnabled;
    updateSettings({ soundEnabled });
    if (soundEnabled) {
        void unlockAudio();
        requestNotificationPermission();
    } else stopAudioPlayback();
    updateAudioControl();
};

function updateAudioControl(state = currentAudioState) {
    currentAudioState = state;
    const button = document.getElementById('sound-toggle-btn');
    if (!button) return;
    const enabled = getSettings().soundEnabled;
    const failed = enabled && state === AUDIO_STATE.FAILED;
    const pending = enabled && state === AUDIO_STATE.LOCKED;
    const label = enabled ? 'كتم صوت تنبيهات الاجتماعات' : 'تفعيل صوت تنبيهات الاجتماعات';
    const tooltip = pending
        ? 'الصوت مفعّل؛ ينتظر أول تفاعل من المتصفح'
        : failed ? 'تعذر تشغيل الصوت؛ أوقفه ثم فعّله للمحاولة' : label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = tooltip;
    button.dataset.tooltip = tooltip;
    button.classList.toggle('is-audio-failed', failed);
    button.classList.toggle('is-audio-pending', pending);
    button.innerHTML = `<i data-lucide="${failed ? 'alert-circle' : enabled ? 'volume-2' : 'volume-x'}"></i>`;
    refreshIcons(button);
}

function getRiyadhCalendarDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function readIqamaProfileSettings(name) {
    const intervals = Object.fromEntries(IQAMA_PRAYER_KEYS.map(key => {
        const raw = document.getElementById(`iqama-${name}-${key}`)?.value ?? '';
        const value = raw.trim() === '' ? null : Number(raw);
        return [key, Number.isInteger(value) ? value : null];
    }));
    return {
        enabled: Boolean(document.getElementById(`iqama-${name}-enabled`)?.checked),
        confirmed: Boolean(document.getElementById(`iqama-${name}-confirmed`)?.checked),
        source: document.getElementById(`iqama-${name}-source`)?.value.trim() || '',
        verifiedAt: document.getElementById(`iqama-${name}-verified`)?.value || '',
        intervals,
        ...(name === 'ramadan' ? {
            startDate: document.getElementById('iqama-ramadan-start')?.value || '',
            endDate: document.getElementById('iqama-ramadan-end')?.value || ''
        } : {})
    };
}

function hydrateIqamaSettings(settings = {}) {
    for (const name of ['regular', 'ramadan']) {
        const profile = settings[name] || {};
        const enabled = document.getElementById(`iqama-${name}-enabled`);
        const confirmed = document.getElementById(`iqama-${name}-confirmed`);
        if (enabled) enabled.checked = profile.enabled === true;
        if (confirmed) confirmed.checked = profile.confirmed === true;
        const source = document.getElementById(`iqama-${name}-source`);
        const verified = document.getElementById(`iqama-${name}-verified`);
        if (source) source.value = profile.source || '';
        if (verified) verified.value = profile.verifiedAt || '';
        for (const key of IQAMA_PRAYER_KEYS) {
            const input = document.getElementById(`iqama-${name}-${key}`);
            if (input) input.value = profile.intervals?.[key] ?? '';
        }
        if (name === 'ramadan') {
            const start = document.getElementById('iqama-ramadan-start');
            const end = document.getElementById('iqama-ramadan-end');
            if (start) start.value = profile.startDate || '';
            if (end) end.value = profile.endDate || '';
        }
    }
}

function collectIqamaSettings() {
    const settings = { regular: readIqamaProfileSettings('regular'), ramadan: readIqamaProfileSettings('ramadan') };
    const error = document.getElementById('iqama-config-error');
    const messages = {
        confirmation_required: 'فعّل التذكير بعد تأكيد مدد مسجدكم ومصدرها فقط.',
        source_required: 'اكتب مصدرًا واضحًا للتحقق، مثل اسم المسجد أو مرجع التعميم.',
        verification_date_invalid: 'أدخل تاريخ تحقق صحيحًا وحديثًا (خلال آخر 366 يومًا).',
        intervals_invalid: 'أدخل مدة صحيحة من 1 إلى 120 دقيقة لكل صلاة.',
        ramadan_range_invalid: 'تحقق من تاريخي بداية ونهاية رمضان؛ المدة لا تتجاوز 37 يومًا.'
    };
    for (const name of ['regular', 'ramadan']) {
        if (!settings[name].enabled) continue;
        const validation = validateIqamaProfile(settings[name], name, getRiyadhCalendarDate());
        if (!validation.valid) {
            if (error) { error.textContent = messages[validation.reason] || 'راجع إعدادات الإقامة قبل الحفظ.'; error.hidden = false; }
            return null;
        }
    }
    if (error) { error.hidden = true; error.textContent = ''; }
    return settings;
}

function showPrayerAlertStatus(message, durationMs = 10000, eventId = '') {
    const status = document.getElementById('prayer-alert-status');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    if (eventId) status.dataset.eventId = eventId;
    if (prayerAlertStatusTimeout) clearTimeout(prayerAlertStatusTimeout);
    if (message) prayerAlertStatusTimeout = setTimeout(() => {
        status.hidden = true;
        status.textContent = '';
        status.dataset.eventId = '';
        prayerAlertStatusTimeout = null;
    }, durationMs);
}

function clearPrayerAlertStatus(eventId) {
    const status = document.getElementById('prayer-alert-status');
    if (!status || status.dataset.eventId !== eventId) return;
    showPrayerAlertStatus('', 0, eventId);
    status.dataset.eventId = '';
}

async function playPrayerAlert(prayer) {
    const label = prayer.kind === 'iqama' ? `إقامة صلاة ${prayer.label}` : `أذان صلاة ${prayer.label}`;
    const result = await playPrayerAnnouncement(() => loadPrayerAudioAsset({ key: prayer.key, kind: prayer.kind }), {
        expiresAt: prayer.expiresAt,
        onDeferred: () => showPrayerAlertStatus(`تأخر ${label} قليلًا لحين انتهاء الصوت الحالي.`, 10000, prayer.id),
        onStarted: () => showPrayerAlertStatus(`يُشغّل الآن ${label}.`, 10000, prayer.id)
    });
    if (result.reason === 'speech_asset_missing') showPrayerAlertStatus(`تم تشغيل التنبيه التمهيدي؛ ملف عبارة ${label} غير جاهز بعد.`, 10000, prayer.id);
    else if (!result.started) showPrayerAlertStatus(`ظهر تذكير ${label} على الشاشة، لكن تعذر تشغيل الصوت.`, 10000, prayer.id);
    else if (result.speechAvailable) setTimeout(() => clearPrayerAlertStatus(prayer.id), 400);
    return result;
}

let settingsReturnFocus = null;
window.toggleSettings = () => {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    const isOpen = !modal.classList.contains('active');
    if (isOpen) {
        settingsReturnFocus = document.activeElement;
        modal.inert = false;
        setModalBackgroundInert(modal, true);
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        queueMicrotask(() => document.getElementById('sheet-key-input')?.focus());
    } else {
        setModalBackgroundInert(modal, false);
        settingsReturnFocus?.focus?.();
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        modal.inert = true;
        settingsReturnFocus = null;
    }
    const settings = getSettings();
    const input = document.getElementById('sheet-key-input');
    if (input) input.value = settings.sheetId || '';
    const citySelect = document.getElementById('prayer-city-select');
    if (citySelect) citySelect.value = getPrayerCity(settings.prayerCity)?.id || 'riyadh';
    hydrateIqamaSettings(settings.prayerIqama || {});
};

window.unlockAudio = () => {
    unlockAudio();
    requestNotificationPermission();
};

async function requestScreenWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
        screenWakeLock = await navigator.wakeLock.request('screen');
        screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
    } catch (error) {
        console.info('[Display] Wake lock unavailable:', error.message);
    }
}

async function toggleDisplayMode() {
    try {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
            document.body.classList.add('display-mode');
            await requestScreenWakeLock();
        } else {
            await document.exitFullscreen();
        }
    } catch (error) {
        console.warn('[Display] Fullscreen request failed:', error);
        setControlFeedback(document.getElementById('display-mode-btn'), 'تعذر تشغيل شاشة العرض', 'error');
    }
}

function syncDisplayModeButton() {
    const active = Boolean(document.fullscreenElement);
    document.body.classList.toggle('display-mode', active);
    if (!active) screenWakeLock?.release?.();
    const button = document.getElementById('display-mode-btn');
    if (!button) return;
    const label = active ? 'إنهاء العرض' : 'شاشة العرض';
    button.dataset.tooltip = active ? 'إنهاء العرض' : 'شاشة العرض';
    button.title = label;
    button.setAttribute('aria-label', active ? 'إنهاء وضع شاشة العرض' : 'تشغيل وضع شاشة العرض');
    button.innerHTML = `<i data-lucide="${active ? 'minimize-2' : 'maximize-2'}"></i>`;
    refreshIcons();
}

window.saveSettings = () => {
    const input = document.getElementById('sheet-key-input');
    if (!input) return;

    const errorMessage = document.getElementById('sheet-key-error');
    
    const val = input.value.trim();
    if (val === '' || /^2PACX-[A-Za-z0-9_-]+$/.test(val)) {
        input.removeAttribute('aria-invalid');
        if (errorMessage) {
            errorMessage.hidden = true;
            errorMessage.textContent = '';
        }
        const city = document.getElementById('prayer-city-select')?.value || 'riyadh';
        const prayerCity = getPrayerCity(city)?.id || 'riyadh';
        const prayerIqama = collectIqamaSettings();
        if (!prayerIqama) return;
        updateSettings({ sheetId: val, prayerCity, prayerIqama });
        prayerCard?.setCity(prayerCity);
        window.toggleSettings();
        window.manualRefresh();
    } else {
        input.setAttribute('aria-invalid', 'true');
        if (errorMessage) {
            errorMessage.textContent = 'المعرّف غير صحيح. استخدم رابط نشر Google Sheets الذي يبدأ بـ 2PACX-.';
            errorMessage.hidden = false;
        }
        input.focus();
    }
};

window.copyToSlack = (btn, text) => {
    if (!btn || !text) return;

    const showSuccess = () => {
        const toast = btn.querySelector('.copy-toast');
        if (toast) {
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        }
    };

    // FUNC-05: Clipboard API with Fallback
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showSuccess).catch(err => {
            console.warn('Clipboard API failed, trying fallback:', err);
            fallbackCopy(text) ? showSuccess() : console.error('Copy failed');
        });
    } else {
        fallbackCopy(text) ? showSuccess() : console.error('Copy failed');
    }
};

function fallbackCopy(text) {
    try {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', '');
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.select();
        const success = document.execCommand('copy');
        document.body.removeChild(el);
        return success;
    } catch (err) {
        return false;
    }
}

// ========================================
// 🚀 Initialization
// ========================================

async function initApp() {
    const meetingsGrid = document.getElementById('meetings-grid');
    if (meetingsGrid) setupMeetingGridResponsiveLayout(meetingsGrid);
    const layoutPreviewMeetings = getLayoutPreviewMeetings();

    const settings = getSettings();
    populatePrayerCities(document.getElementById('prayer-city-select'), settings.prayerCity);
    prayerCard = createPrayerCard(document.getElementById('prayer-card'), { city: settings.prayerCity });
    prayerAlerts = createRiyadhPrayerAlerts({
        getIqamaSettings: () => getSettings().prayerIqama,
        onAlert: prayer => {
            const isIqama = prayer.kind === 'iqama';
            const phrase = isIqama ? `حان موعد إقامة صلاة ${prayer.label}` : `دخل الآن وقت صلاة ${prayer.label}`;
            showPrayerAlertStatus(`${phrase} في الرياض.`, 10000, prayer.id);
            if (isAudioPlaybackEnabled()) return playPrayerAlert(prayer);
            if (pendingPrayerReminderTimeout) clearTimeout(pendingPrayerReminderTimeout);
            if (Date.now() < prayer.expiresAt) {
                pendingPrayerReminder = { createdAt: Date.now(), expiresAt: prayer.expiresAt, prayer };
                pendingPrayerReminderTimeout = setTimeout(() => {
                    pendingPrayerReminder = null;
                    pendingPrayerReminderTimeout = null;
                }, Math.max(0, prayer.expiresAt - Date.now()));
            }
        }
    });
    callReceiver = createCallReceiver();
    dhikrSlider = createDhikrSlider(document.getElementById('dhikr-card'));
    startClock();

    document.getElementById('refresh-now-btn')?.addEventListener('click', window.manualRefresh);
    document.getElementById('theme-toggle-btn')?.addEventListener('click', window.toggleTheme);
    document.getElementById('sound-toggle-btn')?.addEventListener('click', window.toggleSound);
    document.getElementById('settings-toggle-btn')?.addEventListener('click', window.toggleSettings);
    document.getElementById('display-mode-btn')?.addEventListener('click', toggleDisplayMode);
    document.getElementById('save-settings-btn')?.addEventListener('click', window.saveSettings);
    document.getElementById('cancel-settings-btn')?.addEventListener('click', window.toggleSettings);
    document.getElementById('prayer-city-button')?.addEventListener('click', () => {
        window.toggleSettings();
        queueMicrotask(() => document.getElementById('prayer-city-select')?.focus());
    });

    // Theme sync
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
    }

    // Audio State UI Handling
    const resumeAudioFromGesture = event => {
        if (!getSettings().soundEnabled || currentAudioState === AUDIO_STATE.ENABLED) return;
        if (event.target instanceof Element && event.target.closest('#sound-toggle-btn')) return;
        void unlockAudio();
    };
    const resumeAudioFromKey = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        resumeAudioFromGesture(event);
    };
    document.addEventListener('pointerdown', resumeAudioFromGesture, { passive: true });
    document.addEventListener('keydown', resumeAudioFromKey);

    const sheetKeyInput = document.getElementById('sheet-key-input');
    sheetKeyInput?.addEventListener('input', () => {
        sheetKeyInput.removeAttribute('aria-invalid');
        const message = document.getElementById('sheet-key-error');
        if (message) {
            message.hidden = true;
            message.textContent = '';
        }
    });

    setAudioStateListener((state) => {
        updateAudioControl(state);
        if (state === AUDIO_STATE.ENABLED) {
            document.removeEventListener('pointerdown', resumeAudioFromGesture);
            document.removeEventListener('keydown', resumeAudioFromKey);
            if (pendingPrayerReminder && pendingPrayerReminder.expiresAt > Date.now()) {
                const pending = pendingPrayerReminder;
                pendingPrayerReminder = null;
                if (pendingPrayerReminderTimeout) clearTimeout(pendingPrayerReminderTimeout);
                pendingPrayerReminderTimeout = null;
                void playPrayerAlert(pending.prayer);
            }
            callReceiver?.notifyAudioEnabled();
        }
    });
    updateAudioControl();
    if (settings.soundEnabled) void unlockAudio();

    if (layoutPreviewMeetings) {
        activeMeetings = layoutPreviewMeetings;
        activeSyncResult = { meetings: layoutPreviewMeetings, stale: false, error: null, sheetName: 'بيانات العرض التجريبية' };
        updateSyncStatus(activeSyncResult);
        renderUI(activeMeetings);
    } else {
        startNotificationLoop(
            () => activeMeetings,
            formatTodayDate,
            () => {} // onTick
        );

        // Start Auto-Sync (10s interval is handled inside data.js)
        startAutoSync((result) => {
            activeSyncResult = result;
            activeMeetings = result.meetings;
            updateReminderMeetings(activeMeetings);
            updateSyncStatus(result);
            renderUI(activeMeetings);
        });
    }

    if (dynamicUpdateIntervalId) clearInterval(dynamicUpdateIntervalId);
    dynamicUpdateIntervalId = setInterval(updateLiveMeetingState, 1000);

    document.getElementById('test-sound-btn')?.addEventListener('click', event => {
        updateSettings({ soundEnabled: true });
        updateAudioControl();
        void unlockAudio();
        const button = event.currentTarget;
        playTestAlert(success => setControlFeedback(
            button,
            success ? 'اكتمل اختبار الصوت' : 'تعذر تشغيل صوت الاختبار',
            success ? 'success' : 'error'
        ));
    });

    document.addEventListener('keydown', event => {
        const modal = document.getElementById('settings-modal');
        if (modal?.classList.contains('active')) {
            if (event.key === 'Escape') {
                window.toggleSettings();
                return;
            }
            trapDialogFocus(event, modal);
            return;
        }
        if (!modal?.classList.contains('active')) {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
                || event.target instanceof HTMLSelectElement || event.target?.isContentEditable
                || event.target?.closest?.('button, a, [role="button"]')) return;
            if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                window.manualRefresh();
            }
            return;
        }
    });

    document.getElementById('settings-modal')?.addEventListener('click', event => {
        if (event.target.id === 'settings-modal') window.toggleSettings();
    });

    document.addEventListener('fullscreenchange', syncDisplayModeButton);
    document.addEventListener('visibilitychange', () => {
        if (document.body.classList.contains('display-mode') && document.visibilityState === 'visible') requestScreenWakeLock();
        if (document.visibilityState === 'hidden') {
            if (pendingPrayerReminderTimeout) clearTimeout(pendingPrayerReminderTimeout);
            pendingPrayerReminderTimeout = null;
            pendingPrayerReminder = null;
            return;
        }
        if (document.visibilityState === 'visible') {
            prayerCard?.tick(new Date());
            prayerAlerts?.skipMissed(new Date());
        }
    });

    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        prayerCard?.destroy();
        prayerAlerts?.destroy();
        callReceiver?.destroy();
        if (pendingPrayerReminderTimeout) clearTimeout(pendingPrayerReminderTimeout);
        if (prayerAlertStatusTimeout) clearTimeout(prayerAlertStatusTimeout);
        dhikrSlider?.destroy();
        clearInterval(clockIntervalId);
        clearInterval(dynamicUpdateIntervalId);
    }, { once: true });

    refreshIcons();
}

document.addEventListener('DOMContentLoaded', initApp);

