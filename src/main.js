import '@fontsource/ibm-plex-sans-arabic/300.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './style.css';
import {
    createIcons,
    AlertCircle,
    CalendarCheck2,
    CheckCircle2,
    Clock,
    CloudOff,
    Info,
    LoaderCircle,
    Maximize2,
    Minimize2,
    Moon,
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
    stopAudioPlayback
} from './notifications.js';
import { 
    escapeHTML, 
    formatMeetingCount,
    getEngineerShortName,
    isSafeMeetingUrl
} from './utils.js';
import { APP_TIME_ZONE, getEngineerColor, getEngineerTheme } from './config.js';

// ========================================
// 🌐 State & Constants
// ========================================

const DEFAULT_KEY = '2PACX-1vRMptn5kgbKPmukUxf-9os30G_B3HpvenSged4a5D3GcIS8UgAu9inlHRwe2gq28A';
let activeMeetings = [];
let activeSyncResult = null;
// BUG-03 tracker
let clockIntervalId = null;
let dynamicUpdateIntervalId = null;
let sidebarOverlapIndex = 0;
let sidebarOverlapKey = '';
let sidebarOverlapMeetings = [];
let screenWakeLock = null;

function refreshIcons() {
    createIcons({
        icons: {
            AlertCircle,
            CalendarCheck2,
            CheckCircle2,
            Clock,
            CloudOff,
            Info,
            LoaderCircle,
            Maximize2,
            Minimize2,
            Moon,
            RefreshCw,
            Settings,
            Sun,
            Video,
            Volume2,
            VolumeX
        }
    });
}

// ========================================
// ⏰ Utilities
// ========================================

function toEn(str) {
    if (!str) return '0';
    // Convert Arabic digits to English if needed (fallback)
    return str.toString().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

// ⚠️ NOTE: Engineer name matching is also handled in utils.js → getEngineerShortName()
// If you add or rename an engineer, update BOTH functions.
function getDeveloperGradient(team) {
    const color = getEngineerColor(team);
    return `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 68%, #08111f))`;
}

function getMeetingDisplay(meeting) {
    const project = String(meeting?.project || '');
    const ticketNum = project.match(/AA\d+/i)?.[0]?.toUpperCase() || '';
    const typeKeywords = /اون لاين|أون لاين|online|remote|حضوري|خارجي|زيارة|مكتب|مقر/gi;
    const cleaned = project
        .replace(ticketNum, '')
        .replace(typeKeywords, '')
        .replace(/^[\s\-–—:،.]+|[\s\-–—:،.]+$/g, '')
        .trim();
    const parts = cleaned.split(/\s+-\s+|\s{2,}|[_|]+/).map(part => part.trim()).filter(Boolean);
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
    if (el) el.textContent = text;
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
    let peak = null;

    for (const item of active) {
        const overlapping = active.filter(other => (
            item.timing.startMinutes < other.timing.endMinutes &&
            other.timing.startMinutes < item.timing.endMinutes
        ));
        if (!peak || overlapping.length > peak.count) {
            peak = { item, count: overlapping.length };
        }
    }

    const hasPressure = Boolean(peak && peak.count > 1);
    summary.classList.toggle('has-pressure', hasPressure);
    text.textContent = hasPressure
        ? `أعلى ضغط: ${peak.count} اجتماعات متداخلة من ${formatTime12h(peak.item.meeting.time)}`
        : 'جدول اليوم موزع بدون تعارضات';
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

    if (sorted.length > 20) grid.classList.add('grid-is-crowded');
    else grid.classList.remove('grid-is-crowded');

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
            ? { label: 'مكتمل', className: 'is-done', icon: 'check-circle-2' }
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
                 style="background: ${gradient}">
              <div class="card-bg-pattern"></div>
              ${timingState !== 'running'
                ? `<div class="mc-status ${statusMeta.className}"><i data-lucide="${statusMeta.icon}"></i><span>${statusMeta.label}</span></div>`
                : ''}

              ${hasSafeMeetingUrl ? `
                <a href="${escapeHTML(m.meetUrl)}" target="_blank" rel="noopener noreferrer" class="mc-quick-join" aria-label="الانضمام إلى اجتماع ${escapeHTML(client)}">
                  <i data-lucide="video"></i>
                  <span>${joinLabel}</span>
                </a>
              ` : `<div class="mc-location-state ${isOnline ? 'missing-link' : ''}">${noLinkLabel}</div>`}

              <div class="card-content">

                <div class="mc-client">${escapeHTML(client)}</div>

                <div class="mc-engineer">مع ${escapeHTML(engineerLabel)}</div>

                ${projectDesc ? `<div class="mc-project-desc">${escapeHTML(projectDesc)}</div>` : ''}

                ${meetingType ? `<div class="mc-type-badge ${typeClass}">${escapeHTML(meetingType)}</div>` : ''}

                ${ticketNum ? (hasSafeTicketUrl
                    ? `<a class="mc-ticket-pill is-link" href="${escapeHTML(m.ticketUrl)}" target="_blank" rel="noopener noreferrer" aria-label="فتح التذكرة ${ticketNum}">${ticketNum}</a>`
                    : `<div class="mc-ticket-pill">${ticketNum}</div>`) : ''}

                ${relativeLabel ? `<div class="mc-relative">${relativeLabel}</div>` : ''}

                <div class="mc-time">
                  <i data-lucide="clock"></i>
                  <span class="en-nums">${formatTime12h(m.time)}</span>
                </div>

              </div>

              <div class="mc-progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></div>

            </article>
        `;
    }).join('');

    refreshIcons();


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

function updateCountdown(meeting, overlappingCount = 0) {
    const timer = document.getElementById('countdown-timer');
    const badge = document.getElementById('meeting-now-badge');
    const sideDetails = document.getElementById('sidebar-meeting-details');
    const label = document.querySelector('.countdown-label');
    const countdownContainer = document.querySelector('.next-meeting-countdown');
    const joinLink = document.getElementById('side-join-link');
    const caption = document.getElementById('countdown-caption');
    const overlapSwitcher = document.getElementById('overlap-switcher');

    if (!timer || !badge || !sideDetails || !label || !countdownContainer) return;

    if (!meeting) {
        timer.textContent = "00:00";
        badge.style.display = 'none';
        sideDetails.style.display = 'none';
        label.textContent = "لا اجتماعات متبقية اليوم";
        countdownContainer.classList.remove('urgent');
        if (joinLink) joinLink.hidden = true;
        if (caption) caption.hidden = true;
        if (overlapSwitcher) overlapSwitcher.hidden = true;
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
        label.textContent = 'الاجتماع الجاري';
        timer.style.display = 'none'; badge.style.display = 'block';
        badge.textContent = 'الاجتماع جاري الآن';
        if (caption) caption.hidden = true;
    } else if (timing.state === 'overdue') {
        label.textContent = 'اجتماع يحتاج متابعة';
        timer.style.display = 'none'; badge.style.display = 'block';
        badge.textContent = 'اجتماع متأخر الإغلاق';
        if (caption) caption.hidden = true;
    } else {
        label.textContent = timing.minutesUntil <= 5 ? 'يبدأ الاجتماع قريباً' : 'الاجتماع التالي';
        timer.style.display = 'block'; badge.style.display = 'none';
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
        timer.textContent = toEn(timeStr);
    }

    sideDetails.style.display = 'block';

    if (joinLink) {
        const canJoin = isSafeMeetingUrl(meeting.meetUrl);
        joinLink.hidden = !canJoin;
        if (canJoin) joinLink.href = meeting.meetUrl;
        else joinLink.removeAttribute('href');
    }
    
    // Ticket ID Extraction & Project Bold
    const { client: cleanedTitle, projectDesc, ticketNum } = getMeetingDisplay(meeting);
    
    const titleEl = document.getElementById('side-m-title');
    if (titleEl) {
        titleEl.innerHTML = `<span class="side-client">${escapeHTML(cleanedTitle)}</span>` +
            (projectDesc ? `<small>${escapeHTML(projectDesc)}</small>` : '') +
            (ticketNum ? (isSafeMeetingUrl(meeting.ticketUrl)
                ? `<a class="ticket-pill" href="${escapeHTML(meeting.ticketUrl)}" target="_blank" rel="noopener noreferrer">${ticketNum}</a>`
                : `<span class="ticket-pill">${ticketNum}</span>`) : '');
    }
    
    // Overlapping message & Dimmed Meta
    let metaText = `${meeting.team} — ${formatTime12h(meeting.time)}`;
    const metaEl = document.getElementById('side-m-meta');
    if (metaEl) {
        metaEl.style.opacity = '0.6';
        metaEl.textContent = metaText;
    }

    if (overlapSwitcher) {
        overlapSwitcher.hidden = overlappingCount <= 1;
        if (overlappingCount > 1) {
            overlapSwitcher.textContent = `${sidebarOverlapIndex + 1} من ${overlappingCount} · عرض الاجتماع المتزامن التالي`;
        }
    }

    // Automated Aurora Intensity & Position
    const intensity = (diff > 0 && diff < 5 * 60000) ? 0.25 : 0.12;
    const pos = (diff > 0 && diff < 5 * 60000) ? '50% 10%' : '50% 30%';
    document.documentElement.style.setProperty('--aurora-intensity', intensity);
    document.documentElement.style.setProperty('--aurora-pos', pos);
}

function updateDynamicState() {
    if (!activeMeetings || !activeMeetings.length) {
        updateCountdown(null);
        return;
    }

    const today = formatTodayDate();
    const filtered = activeMeetings.filter(m => m.date === today && !isCancelled(m));
    
    const pending = filtered
        .filter(m => !isDone(m))
        .map(m => ({ m, timing: getMeetingTimingState(m) }))
        .filter(item => ['running', 'upcoming'].includes(item.timing.state))
        .sort((a, b) => {
            if (a.timing.state === 'running' && b.timing.state !== 'running') return -1;
            if (b.timing.state === 'running' && a.timing.state !== 'running') return 1;
            return a.timing.minutesUntil - b.timing.minutesUntil;
        });

    const match = pending[0] || null;
    const overlaps = match
        ? pending
            .filter(item => (
                item.timing.startMinutes < match.timing.endMinutes &&
                match.timing.startMinutes < item.timing.endMinutes
            ))
            .map(item => item.m)
        : [];
    const overlapKey = overlaps.map(meeting => meeting.id).join('|');
    if (overlapKey !== sidebarOverlapKey) {
        sidebarOverlapKey = overlapKey;
        sidebarOverlapIndex = 0;
    }
    sidebarOverlapMeetings = overlaps;
    const current = overlaps[sidebarOverlapIndex] || match?.m || null;

    // Aurora Color Mapping
    const auroraColor = current ? getEngineerColor(current.team) : '#2962FF';
    document.documentElement.style.setProperty('--aurora-color', `${auroraColor}22`);

    // Overlapping meetings detection (diff < 5 mins)
    updateCountdown(current, overlaps.length);
}

// ========================================
// 🔘 UI Handlers
// ========================================

function updateSyncStatus(result, isLoading = false) {
    const container = document.getElementById('sync-status');
    const text = document.getElementById('sync-status-text');
    const meta = document.getElementById('sync-status-meta');
    if (!container || !text || !meta) return;

    container.className = 'sync-status';
    if (isLoading) {
        container.classList.add('is-loading');
        text.textContent = 'جاري تحديث البيانات';
        meta.textContent = result?.sheetName || 'مصدر الاجتماعات';
        return;
    }

    if (result?.error) {
        container.classList.add(result.stale ? 'has-error' : 'is-cached');
        text.textContent = result.stale ? 'البيانات قديمة' : 'نعرض نسخة محفوظة';
        meta.textContent = result.error;
        return;
    }

    container.classList.add('is-online');
    text.textContent = 'البيانات محدثة';
    container.dataset.lastSync = result?.lastSync || '';
    container.dataset.sheetName = result?.sheetName || 'الشهر الحالي';
    updateSyncAge();
}

function updateSyncAge() {
    const container = document.getElementById('sync-status');
    const meta = document.getElementById('sync-status-meta');
    if (!container?.classList.contains('is-online') || !meta) return;
    const lastSync = container.dataset.lastSync;
    if (!lastSync) {
        meta.textContent = 'محدّث الآن';
        return;
    }
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(lastSync).getTime()) / 1000));
    const age = seconds < 45 ? 'الآن' : seconds < 3600 ? `منذ ${Math.floor(seconds / 60)} دقيقة` : `منذ ${Math.floor(seconds / 3600)} ساعة`;
    meta.textContent = `${container.dataset.sheetName} • ${age}`;
}

function setControlFeedback(button, message) {
    if (!button) return;
    const original = button.dataset.tooltip;
    button.dataset.tooltip = message;
    button.classList.add('is-success');
    setTimeout(() => {
        button.dataset.tooltip = original;
        button.classList.remove('is-success');
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
        updateSyncStatus(result);
        renderUI(activeMeetings);
    } finally {
        window._isManualRefreshing = false;
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            setControlFeedback(btn, 'تم التحديث');
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
    const soundEnabled = !settings.soundEnabled;
    updateSettings({ soundEnabled });
    if (soundEnabled) {
        unlockAudio();
        requestNotificationPermission();
    }
    
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
        btn.innerHTML = `<i data-lucide="${soundEnabled ? 'volume-2' : 'volume-x'}"></i>`;
        refreshIcons();
    }
    if (!soundEnabled) {
        stopAudioPlayback();
        const status = document.getElementById('audio-status');
        status?.classList.remove('enabled', 'failed');
        status?.classList.add('locked');
        const statusText = status?.querySelector('.status-text');
        if (statusText) statusText.textContent = 'الصوت متوقف';
        status?.setAttribute('aria-label', 'تفعيل صوت التنبيهات');
    }
};

let settingsReturnFocus = null;
window.toggleSettings = () => {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    const isOpen = modal.classList.toggle('active');
    modal.setAttribute('aria-hidden', String(!isOpen));
    if (isOpen) {
        settingsReturnFocus = document.activeElement;
        queueMicrotask(() => document.getElementById('sheet-key-input')?.focus());
    } else {
        settingsReturnFocus?.focus?.();
    }
    const settings = getSettings();
    const input = document.getElementById('sheet-key-input');
    if (input) input.value = settings.sheetId || DEFAULT_KEY;
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
    
    const val = input.value.trim();
    if (/^2PACX-[A-Za-z0-9_-]+$/.test(val)) {
        input.removeAttribute('aria-invalid');
        updateSettings({ sheetId: val });
        window.toggleSettings();
        window.manualRefresh();
    } else {
        input.setAttribute('aria-invalid', 'true');
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
    startClock();
    
    const settings = getSettings();

    document.getElementById('refresh-now-btn')?.addEventListener('click', window.manualRefresh);
    document.getElementById('theme-toggle-btn')?.addEventListener('click', window.toggleTheme);
    document.getElementById('sound-toggle-btn')?.addEventListener('click', window.toggleSound);
    document.getElementById('settings-toggle-btn')?.addEventListener('click', window.toggleSettings);
    document.getElementById('display-mode-btn')?.addEventListener('click', toggleDisplayMode);
    document.getElementById('overlap-switcher')?.addEventListener('click', () => {
        if (sidebarOverlapMeetings.length < 2) return;
        sidebarOverlapIndex = (sidebarOverlapIndex + 1) % sidebarOverlapMeetings.length;
        updateDynamicState();
    });
    document.getElementById('save-settings-btn')?.addEventListener('click', window.saveSettings);
    document.getElementById('cancel-settings-btn')?.addEventListener('click', window.toggleSettings);

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
    const audioStatusBadge = document.getElementById('audio-status');
    const audioOverlay = document.getElementById('audio-unlock-overlay');
    const audioEnableButton = audioOverlay?.querySelector('.btn-prime');
    const continueWithoutSoundButton = document.getElementById('continue-without-sound');

    audioStatusBadge?.addEventListener('click', () => {
        if (audioStatusBadge.classList.contains('enabled')) {
            playTestAlert();
            setControlFeedback(audioStatusBadge, 'تم اختبار الصوت');
        } else {
            updateSettings({ soundEnabled: true });
            unlockAudio();
            requestNotificationPermission();
        }
    });

    const setAudioOverlayVisible = visible => {
        if (!audioOverlay) return;
        audioOverlay.hidden = !visible;
        audioOverlay.classList.toggle('active', visible);
        audioOverlay.setAttribute('aria-hidden', String(!visible));
        if (visible) audioOverlay.removeAttribute('inert');
        else audioOverlay.setAttribute('inert', '');
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
        audioStatusBadge?.classList.remove('enabled', 'failed');
        audioStatusBadge?.classList.add('locked');
        const statusText = audioStatusBadge?.querySelector('.status-text');
        if (statusText) statusText.textContent = 'الصوت متوقف';
        audioStatusBadge?.setAttribute('aria-label', 'تفعيل صوت التنبيهات');
        refreshIcons();
    });

    if (!settings.soundEnabled) setAudioOverlayVisible(false);
    else queueMicrotask(() => audioEnableButton?.focus());

    setAudioStateListener((state) => {
        // Ensure LED exists next to #live-clock
        let led = document.getElementById('audio-led');
        if (!led) {
            const clock = document.getElementById('live-clock');
            if (clock) {
                led = document.createElement('span');
                led.id = 'audio-led';
                clock.parentNode.insertBefore(led, clock.nextSibling);
            }
        }

        if (!audioStatusBadge) return;
        
        // Update LED color
        if (led) {
            if (state === AUDIO_STATE.ENABLED) led.style.background = '#22c55e';
            else if (state === AUDIO_STATE.FAILED) led.style.background = '#f59e0b';
            else led.style.background = '#ef4444';
        }

        // Remove all state classes (Legacy sync)
        audioStatusBadge.classList.remove('locked', 'enabled', 'failed');
        audioStatusBadge.classList.add(state);

        const icon = audioStatusBadge.querySelector('i, svg');
        const text = audioStatusBadge.querySelector('.status-text');

        if (state === AUDIO_STATE.ENABLED) {
            if (icon) icon.setAttribute('data-lucide', 'volume-2');
            if (text) text.textContent = 'الصوت مفعّل';
            audioStatusBadge.setAttribute('aria-label', 'اختبار صوت التنبيهات');
            setAudioOverlayVisible(false);
        } else if (state === AUDIO_STATE.FAILED) {
            if (icon) icon.setAttribute('data-lucide', 'alert-circle');
            if (text) text.textContent = 'تعذر تشغيل الصوت';
            audioStatusBadge.setAttribute('aria-label', 'إعادة محاولة تشغيل الصوت');
        } else {
            if (icon) icon.setAttribute('data-lucide', 'volume-x');
            if (text) text.textContent = 'اضغط لتفعيل الصوت';
            audioStatusBadge.setAttribute('aria-label', 'تفعيل صوت التنبيهات');
            if (getSettings().soundEnabled) setAudioOverlayVisible(true);
        }

        refreshIcons();
    });

    startNotificationLoop(
        () => activeMeetings,
        formatTodayDate,
        () => {} // onTick
    );

    // Start Auto-Sync (10s interval is handled inside data.js)
    startAutoSync((result) => {
        activeSyncResult = result;
        activeMeetings = result.meetings;
        updateSyncStatus(result);
        renderUI(activeMeetings);
    });

    if (dynamicUpdateIntervalId) clearInterval(dynamicUpdateIntervalId);
    dynamicUpdateIntervalId = setInterval(() => updateDynamicState(), 1000);

    document.getElementById('test-sound-btn')?.addEventListener('click', () => {
        unlockAudio();
        playTestAlert();
    });

    document.addEventListener('keydown', event => {
        const modal = document.getElementById('settings-modal');
        if (!modal?.classList.contains('active')) {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                window.manualRefresh();
            } else if (event.key === 'Enter') {
                const joinLink = document.getElementById('side-join-link');
                if (joinLink && !joinLink.hidden) joinLink.click();
            }
            return;
        }
        if (event.key === 'Escape') {
            window.toggleSettings();
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
                .filter(element => !element.disabled);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
    });

    document.getElementById('settings-modal')?.addEventListener('click', event => {
        if (event.target.id === 'settings-modal') window.toggleSettings();
    });

    document.addEventListener('fullscreenchange', syncDisplayModeButton);
    document.addEventListener('visibilitychange', () => {
        if (document.body.classList.contains('display-mode') && document.visibilityState === 'visible') requestScreenWakeLock();
    });

    refreshIcons();
}

document.addEventListener('DOMContentLoaded', initApp);

