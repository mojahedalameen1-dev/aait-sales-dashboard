import './style.css';
import { 
    startAutoSync, 
    fetchMeetings, 
    getSettings, 
    updateSettings, 
    formatTime12h, 
    isDone, 
    isCancelled,
    formatTodayDate
} from './data.js';
import { 
    startNotificationLoop, 
    requestNotificationPermission,
    unlockAudio,
    setAudioStateListener,
    AUDIO_STATE
} from './notifications.js';
import { 
    escapeHTML, 
    formatMeetingCount,
    getEngineerShortName
} from './utils.js';

// ========================================
// 🌐 State & Constants
// ========================================

const DEFAULT_KEY = '2PACX-1vRMptn5kgbKPmukUxf-9os30G_B3HpvenSged4a5D3GcIS8UgAu9inlHRwe2gq28A';
let activeMeetings = [];
// BUG-03 tracker
let clockIntervalId = null;
let dynamicUpdateIntervalId = null;

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
    const t = (team || '').toLowerCase();
    if (/أشرف|اشرف|ashraf/i.test(t)) return 'linear-gradient(135deg, #00C853, #1de9b6)';
    if (/مجاهد|mojahed/i.test(t)) return 'linear-gradient(135deg, #2962FF, #00B0FF)';
    if (/شادي|shady/i.test(t)) return 'linear-gradient(135deg, #C6242C, #9B1B22)';
    if (/حسام|hossam/i.test(t)) return 'linear-gradient(135deg, #FF6D00, #FFAB00)';
    return 'linear-gradient(135deg, #334155, #1e293b)';
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

function renderUI(meetings) {
    const grid = document.getElementById('meetings-grid');
    if (!grid) {
        console.error('Missing #meetings-grid');
        return;
    }

    const today = formatTodayDate();
    const todayMeetings = meetings.filter(m => m.date === today);

    // Update Stats (Arabic Grammar)
    const nowTime = new Date();
    const nowMins = nowTime.getHours() * 60 + nowTime.getMinutes();
    const runningNow = todayMeetings.filter(m => {
        if (isDone(m) || isCancelled(m)) return false;
        const [h, mi] = (m.time || '00:00').split(':').map(Number);
        const startMins = h * 60 + mi;
        return nowMins >= startMins && nowMins <= (startMins + 60);
    });

    animateCount('stat-total', todayMeetings.length);
    animateCount('stat-done', todayMeetings.filter(m => isDone(m)).length);
    animateCount('stat-pending', todayMeetings.filter(m => !isDone(m) && !isCancelled(m)).length);
    animateCount('stat-urgent', runningNow.length);

    // Sorting: Pending First, then Done, then Cancelled
    const sorted = [...todayMeetings].sort((a, b) => {
        const aDone = isDone(a) || isCancelled(a);
        const bDone = isDone(b) || isCancelled(b);
        if (aDone && !bDone) return 1;
        if (!aDone && bDone) return -1;
        return (a.time || '').localeCompare(b.time || '');
    });

    // TODO: grid-is-crowded CSS rules are not yet implemented.
    // Reserved for future compact layout when meeting count exceeds 20.
    if (sorted.length > 20) grid.classList.add('grid-is-crowded');
    else grid.classList.remove('grid-is-crowded');

    grid.innerHTML = sorted.map(m => {
        const done = isDone(m);
        const cancelled = isCancelled(m);
        const gradient = getDeveloperGradient(m.team);
        const ticketMatch = m.project?.match(/AA\d+/);
        const ticketNum = ticketMatch ? ticketMatch[0] : '';
        const cleanTitle = (m.project || '').replace(ticketNum, '').trim();
        const engineerLabel = getEngineerShortName(m.team);

        return `
            <div class="meeting-card ${done ? 'completed' : ''} ${cancelled ? 'cancelled' : ''}"
                 style="background: ${gradient}">
              <div class="card-bg-pattern"></div>
              ${cancelled ? '<div class="move-alert"><i data-lucide="info"></i> ملغي / تعديل</div>' : ''}

              <div class="card-content">

                <div class="mc-engineer">اجتماع ${escapeHTML(engineerLabel)}</div>

                <div class="mc-title">${escapeHTML(cleanTitle || '—')}</div>

                ${ticketNum ? `<div class="mc-ticket-pill">${ticketNum}</div>` : ''}

                <div class="mc-time">
                  <i data-lucide="clock"></i>
                  <span class="en-nums">${formatTime12h(m.time)}</span>
                </div>

                <div class="mc-blocks">
                  ${(/بعد|remote|zoom|google meet|online/i.test(m.via || '')) ? `
                    <div class="mc-block">
                      <div class="mc-block-header"><span>انضم إلى جوجل ميت</span></div>
                      <a href="${m.meetUrl || '#'}" target="_blank"
                         class="mc-btn gold-btn ${!m.meetUrl ? 'not-available' : ''}">
                        <i data-lucide="video" class="btn-icon"></i> دخول
                      </a>
                    </div>
                  ` : ''}
                </div>

              </div>

              ${done ? '<div class="completed-icon"><i data-lucide="check-circle-2"></i></div>' : ''}
            </div>
        `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();


    updateDynamicState();
}

// ========================================
// ⏰ Clock & Countdown
// ========================================

function startClock() {
    const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

    if (clockIntervalId) clearInterval(clockIntervalId);
    clockIntervalId = setInterval(() => {
        const now = new Date();
        let h = now.getHours();
        const m = String(now.getMinutes()).padStart(2, '0');
        const suffix = h < 12 ? 'ص' : 'م';
        h = h % 12 || 12;
        
        setSafeText('live-clock', `${h}:${m} ${suffix}`);
        
        // FUNC-08: Manual Date building for English Digits
        const dateStr = `${days[now.getDay()]}، ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
        setSafeText('live-date', dateStr);
    }, 1000);
}

function updateCountdown(meeting, overlappingCount = 0) {
    const timer = document.getElementById('countdown-timer');
    const badge = document.getElementById('meeting-now-badge');
    const sideDetails = document.getElementById('sidebar-meeting-details');
    const label = document.querySelector('.countdown-label');
    const countdownContainer = document.querySelector('.next-meeting-countdown');

    if (!timer || !badge || !sideDetails || !label || !countdownContainer) return;

    if (!meeting) {
        timer.textContent = "00:00";
        badge.style.display = 'none';
        sideDetails.style.display = 'none';
        label.textContent = "لا اجتماعات متبقية اليوم";
        countdownContainer.classList.remove('urgent');
        return;
    }

    label.textContent = "متبقى على الاجتماع القادم :";
    const now = new Date();
    const [h, mi] = meeting.time.split(':').map(Number);
    const target = new Date(); target.setHours(h, mi, 0, 0);
    const diff = target - now;

    // Urgency handling (< 5 mins)
    if (diff > 0 && diff < 5 * 60000) {
        countdownContainer.classList.add('urgent');
        timer.style.color = 'var(--color-urgent)';
    } else {
        countdownContainer.classList.remove('urgent');
        timer.style.color = 'var(--text-white)';
    }

    if (diff <= 0) {
        timer.style.display = 'none'; badge.style.display = 'block';
    } else {
        timer.style.display = 'block'; badge.style.display = 'none';
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
    
    // Ticket ID Extraction & Project Bold
    const projectText = meeting.project || '';
    const ticketMatch = projectText.match(/AA\d+/);
    const ticketNum = ticketMatch ? ticketMatch[0] : '';
    const cleanedTitle = projectText.replace(ticketNum, '').trim();
    
    const titleEl = document.getElementById('side-m-title');
    if (titleEl) {
        titleEl.innerHTML = `<span style="font-weight: 800;">${escapeHTML(cleanedTitle)}</span>` + 
                            (ticketNum ? `<span class="ticket-pill">${ticketNum}</span>` : '');
    }
    
    // Overlapping message & Dimmed Meta
    let metaText = `${meeting.team} — ${formatTime12h(meeting.time)}`;
    const metaEl = document.getElementById('side-m-meta');
    if (metaEl) {
        metaEl.style.opacity = '0.6';
        if (overlappingCount > 1) {
            const extra = overlappingCount - 1;
            const msgHtml = `<div class="overlapping-msg">+ ${extra} اجتماعات في نفس الوقت</div>`;
            metaEl.innerHTML = `${escapeHTML(metaText)}${msgHtml}`;
        } else {
            metaEl.textContent = metaText;
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
    
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    
    let pending = filtered
        .filter(m => !isDone(m))
        .map(m => { 
            const [h, mi] = m.time.split(':').map(Number); 
            return { m, mins: h * 60 + mi }; 
        })
        .sort((a, b) => a.mins - b.mins);

    const match = pending.find(x => x.mins >= nowMins - 120);
    let current = match ? match.m : null;
    
    // Aurora Color Mapping
    const engineerColorMap = {
        'ashraf': '#00C853',
        'ashraf_ar': 'أشرف',
        'mojahed': '#2962FF',
        'shady': '#C6242C',
        'hossam': '#FF6D00'
    };

    let auroraColor = '#2962FF'; // Default Blue
    if (current && current.team) {
        const team = current.team.toLowerCase();
        if (team.includes('أشرف') || team.includes('اشرف')) auroraColor = '#00C853';
        else if (team.includes('مجاهد')) auroraColor = '#2962FF';
        else if (team.includes('شادي')) auroraColor = '#C6242C';
        else if (team.includes('حسام')) auroraColor = '#FF6D00';
    }
    document.documentElement.style.setProperty('--aurora-color', `${auroraColor}22`);

    // Overlapping meetings detection (diff < 5 mins)
    let overlappingCount = 0;
    if (match) {
        const baseMins = match.mins;
        const overlaps = pending.filter(x => Math.abs(x.mins - baseMins) < 5);
        overlappingCount = overlaps.length;
    }
    
    updateCountdown(current, overlappingCount);
}

// ========================================
// 🔘 UI Handlers
// ========================================

window.manualRefresh = async () => {
    if (window._isManualRefreshing) return;
    window._isManualRefreshing = true;

    const btn = document.getElementById('refresh-now-btn');
    if (btn) btn.style.opacity = '0.5';

    try {
        const result = await fetchMeetings();
        activeMeetings = result.meetings;
        renderUI(activeMeetings);
    } finally {
        window._isManualRefreshing = false;
        if (btn) setTimeout(() => btn.style.opacity = '1', 1000);
    }
};

window.toggleTheme = () => {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    // Important: Query for i OR svg because Lucide replaces them
    const icon = document.querySelector('#theme-toggle-btn i, #theme-toggle-btn svg');
    if (icon) {
        icon.setAttribute('data-lucide', isLight ? 'sun' : 'moon');
        if (window.lucide) window.lucide.createIcons();
    }
};

window.toggleSound = () => {
    const settings = getSettings();
    const soundEnabled = !settings.soundEnabled;
    updateSettings({ soundEnabled });
    
    const btn = document.getElementById('sound-toggle-btn');
    if (btn) {
        btn.innerHTML = `<i data-lucide="${soundEnabled ? 'volume-2' : 'volume-x'}"></i>`;
        if (window.lucide) window.lucide.createIcons();
    }
};

window.toggleSettings = () => {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    
    modal.style.display = (modal.style.display === 'flex') ? 'none' : 'flex';
    const settings = getSettings();
    const input = document.getElementById('sheet-key-input');
    if (input) input.value = settings.sheetId || DEFAULT_KEY;
};

window.unlockAudio = () => {
    unlockAudio();
};

window.saveSettings = () => {
    const input = document.getElementById('sheet-key-input');
    if (!input) return;
    
    const val = input.value.trim();
    if (val) {
        updateSettings({ sheetId: val });
        window.toggleSettings();
        window.manualRefresh();
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

    // Theme sync
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
    }

    // Sound sync
    if (!settings.soundEnabled) {
        const icon = document.querySelector('#sound-toggle-btn i, #sound-toggle-btn svg');
        if (icon) {
            icon.setAttribute('data-lucide', 'volume-x');
            if (window.lucide) window.lucide.createIcons();
        }
    }

    // Audio State UI Handling
    const audioStatusBadge = document.getElementById('audio-status');
    const audioOverlay = document.getElementById('audio-unlock-overlay');

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

        const icon = audioStatusBadge.querySelector('i');
        const text = audioStatusBadge.querySelector('.status-text');

        if (state === AUDIO_STATE.ENABLED) {
            if (icon) icon.setAttribute('data-lucide', 'volume-2');
            if (text) text.textContent = 'Audio Enabled';
            if (audioOverlay) audioOverlay.classList.remove('active');
        } else if (state === AUDIO_STATE.FAILED) {
            if (icon) icon.setAttribute('data-lucide', 'alert-circle');
            if (text) text.textContent = 'Audio Failed';
        } else {
            if (icon) icon.setAttribute('data-lucide', 'volume-x');
            if (text) text.textContent = 'Audio Locked';
            if (audioOverlay) audioOverlay.classList.add('active');
        }

        if (window.lucide) window.lucide.createIcons();
    });

    // Audio Unlock Listener (CRITICAL for Autoplay policies)
    const handleFirstInteraction = () => {
        unlockAudio();
        document.removeEventListener('click', handleFirstInteraction);
        document.removeEventListener('keydown', handleFirstInteraction);
    };
    document.addEventListener('click', handleFirstInteraction);
    document.addEventListener('keydown', handleFirstInteraction);

    // BUG-01: Initialization of Notifications
    requestNotificationPermission();
    startNotificationLoop(
        () => activeMeetings,
        formatTodayDate,
        () => {} // onTick
    );

    // Start Auto-Sync (10s interval is handled inside data.js)
    startAutoSync((result) => {
        activeMeetings = result.meetings;
        renderUI(activeMeetings);
    });

    if (dynamicUpdateIntervalId) clearInterval(dynamicUpdateIntervalId);
    dynamicUpdateIntervalId = setInterval(() => updateDynamicState(), 1000);
}

document.addEventListener('DOMContentLoaded', initApp);

