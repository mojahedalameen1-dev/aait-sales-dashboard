import '@fontsource/ibm-plex-sans-arabic/300.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './style.css';
import './sidebar.css';
import './meeting-cards.css';
import { createPrayerCard, populatePrayerCities } from './prayer-card.js';
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
    updateReminderMeetings
} from './notifications.js';
import { 
    escapeHTML, 
    formatMeetingCount,
    getEngineerShortName,
    isSafeMeetingUrl,
    toEnglishDigits
} from './utils.js';
import { APP_TIME_ZONE, getEngineerColor, getEngineerTheme, getEngineerProfile } from './config.js';

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
let dhikrSlider = null;
let currentAudioState = AUDIO_STATE.LOCKED;

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
        const startsSoon = timingState === 'upcoming' && timing.minutesUntil <= 10;
        const statusMeta = done
            ? { label: 'منتهي', className: 'is-done', icon: 'check-circle-2' }
            : cancelled
                ? { label: 'ملغي / تعديل', className: 'is-cancelled', icon: 'info' }
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
            <article class="meeting-card ${done ? 'completed' : ''} ${cancelled ? 'cancelled' : ''}
                 ${timingState === 'running' ? 'current' : ''} ${timingState === 'overdue' ? 'overdue' : ''}
                 ${engineerTheme !== 'default' ? `theme-${engineerTheme}` : ''}"
                 style="background: ${gradient}" data-meeting-id="${escapeHTML(String(m.id))}" tabindex="-1">
              <div class="card-bg-pattern"></div>
              <header class="mc-header">
              ${timingState !== 'running'
                ? `<div class="mc-status ${statusMeta.className}"><i data-lucide="${statusMeta.icon}"></i><span>${statusMeta.label}</span></div>`
                : ''}

              ${hasSafeMeetingUrl ? `
                <a href="${escapeHTML(m.meetUrl)}" target="_blank" rel="noopener noreferrer" class="mc-quick-join" aria-label="الانضمام إلى اجتماع ${escapeHTML(client)}">
                  <i data-lucide="video"></i>
                  <span>${joinLabel}</span>
                </a>
              ` : `<div class="mc-location-state ${isOnline ? 'missing-link' : ''}">${noLinkLabel}</div>`}
              </header>

              <div class="card-content">
                <div class="mc-details">
                  <div class="mc-client" title="${safeDisplayText(client)}">${safeDisplayText(client)}</div>
                  <div class="mc-engineer" title="مع ${safeDisplayText(engineerLabel)}">مع ${safeDisplayText(engineerLabel)}</div>
                  ${projectDesc ? `<div class="mc-project-desc" title="${safeDisplayText(projectDesc)}">${safeDisplayText(projectDesc)}</div>` : ''}
                  <div class="mc-meta">
                    ${meetingType ? `<div class="mc-type-badge ${typeClass}" title="${safeDisplayText(meetingType)}">${safeDisplayText(meetingType)}</div>` : ''}
                    ${ticketNum ? (hasSafeTicketUrl
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
        const alertLabel = reminder.minutesType === 30 ? 'النداء الأول' : 'النداء الثاني';
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
    button.classList.toggle('is-success', kind === 'success');
    button.classList.toggle('is-error', kind === 'error');
    setTimeout(() => {
        button.dataset.tooltip = original;
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
    const settings = getSettings();
    if (settings.soundEnabled && currentAudioState !== AUDIO_STATE.ENABLED) {
        unlockAudio();
        requestNotificationPermission();
        return;
    }
    const soundEnabled = !settings.soundEnabled;
    updateSettings({ soundEnabled });
    if (soundEnabled) {
        unlockAudio();
        requestNotificationPermission();
    }
    
    if (!soundEnabled) stopAudioPlayback();
    updateAudioControl();
};

function updateAudioControl(state = currentAudioState) {
    currentAudioState = state;
    const button = document.getElementById('sound-toggle-btn');
    if (!button) return;
    const enabled = getSettings().soundEnabled;
    const failed = enabled && state === AUDIO_STATE.FAILED;
    const label = !enabled ? 'تفعيل صوت تنبيهات الاجتماعات'
        : failed ? 'تعذر تشغيل الصوت؛ اضغط لإعادة التفعيل'
            : state === AUDIO_STATE.ENABLED ? 'كتم صوت تنبيهات الاجتماعات' : 'تفعيل صوت تنبيهات الاجتماعات';
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = label;
    button.dataset.tooltip = label;
    button.classList.toggle('is-audio-failed', failed);
    button.innerHTML = `<i data-lucide="${failed ? 'alert-circle' : enabled && state === AUDIO_STATE.ENABLED ? 'volume-2' : 'volume-x'}"></i>`;
    refreshIcons(button);
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
    }
}

function syncDisplayModeButton() {
    const active = Boolean(document.fullscreenElement);
    document.body.classList.toggle('display-mode', active);
    if (!active) screenWakeLock?.release?.();
    const button = document.getElementById('display-mode-btn');
    if (!button) return;
    button.dataset.tooltip = active ? 'إنهاء العرض' : 'شاشة العرض';
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
        updateSettings({ sheetId: val, prayerCity });
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
    const settings = getSettings();
    populatePrayerCities(document.getElementById('prayer-city-select'), settings.prayerCity);
    prayerCard = createPrayerCard(document.getElementById('prayer-card'), { city: settings.prayerCity });
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

    // Sound sync
    if (!settings.soundEnabled) {
        const icon = document.querySelector('#sound-toggle-btn i, #sound-toggle-btn svg');
        if (icon) {
            icon.setAttribute('data-lucide', 'volume-x');
            refreshIcons();
        }
    }

    // Audio State UI Handling
    const soundToggleButton = document.getElementById('sound-toggle-btn');
    const audioOverlay = document.getElementById('audio-unlock-overlay');
    const audioEnableButton = audioOverlay?.querySelector('.btn-prime');
    const continueWithoutSoundButton = document.getElementById('continue-without-sound');

    const setAudioOverlayVisible = visible => {
        if (!audioOverlay) return;
        if (!visible && !audioOverlay.classList.contains('active')) return;

        if (visible) {
            audioOverlay.hidden = false;
            audioOverlay.inert = false;
            audioOverlay.classList.add('active');
            audioOverlay.setAttribute('aria-hidden', 'false');
            setModalBackgroundInert(audioOverlay, true);
            if (!audioOverlay.contains(document.activeElement)) queueMicrotask(() => audioEnableButton?.focus());
            return;
        }

        setModalBackgroundInert(audioOverlay, false);
        if (audioOverlay.contains(document.activeElement)) soundToggleButton?.focus({ preventScroll: true });
        audioOverlay.classList.remove('active');
        audioOverlay.setAttribute('aria-hidden', 'true');
        audioOverlay.inert = true;
        audioOverlay.hidden = true;
    };

    audioEnableButton?.addEventListener('click', () => {
        unlockAudio();
        requestNotificationPermission();
    });

    continueWithoutSoundButton?.addEventListener('click', () => {
        updateSettings({ soundEnabled: false });
        stopAudioPlayback();
        setAudioOverlayVisible(false);
        const soundButton = document.getElementById('sound-toggle-btn');
        if (soundButton) soundButton.innerHTML = '<i data-lucide="volume-x"></i>';
        updateAudioControl();
        refreshIcons();
    });

    if (!settings.soundEnabled) setAudioOverlayVisible(false);
    else setAudioOverlayVisible(true);

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
            setAudioOverlayVisible(false);
        } else if (state !== AUDIO_STATE.FAILED) {
            if (getSettings().soundEnabled) setAudioOverlayVisible(true);
        }
    });
    updateAudioControl();

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

    if (dynamicUpdateIntervalId) clearInterval(dynamicUpdateIntervalId);
    dynamicUpdateIntervalId = setInterval(updateLiveMeetingState, 1000);

    document.getElementById('test-sound-btn')?.addEventListener('click', event => {
        updateSettings({ soundEnabled: true });
        updateAudioControl();
        unlockAudio();
        const button = event.currentTarget;
        playTestAlert(success => setControlFeedback(
            button,
            success ? 'اكتمل اختبار الصوت' : 'تعذر تشغيل صوت الاختبار',
            success ? 'success' : 'error'
        ));
    });

    document.addEventListener('keydown', event => {
        const modal = document.getElementById('settings-modal');
        const audioDialog = document.getElementById('audio-unlock-overlay');
        if (modal?.classList.contains('active')) {
            if (event.key === 'Escape') {
                window.toggleSettings();
                return;
            }
            trapDialogFocus(event, modal);
            return;
        }
        if (audioDialog?.classList.contains('active')) {
            trapDialogFocus(event, audioDialog);
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
        if (document.visibilityState === 'visible') prayerCard?.tick(new Date());
    });

    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        prayerCard?.destroy();
        dhikrSlider?.destroy();
        clearInterval(clockIntervalId);
        clearInterval(dynamicUpdateIntervalId);
    }, { once: true });

    refreshIcons();
}

document.addEventListener('DOMContentLoaded', initApp);

