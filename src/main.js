/**
 * main.js — App entry point: initialization, rendering, auto-refresh, UI control
 * Updated with Premium UI + Daily Stats + Urgency Logic
 */

import './style.css';
import {
  startAutoSync,
  stopAutoSync,
  fetchMeetings,
  groupByDate,
  getNextMeeting,
  formatTodayDate,
  getLastSyncTime,
  getSettings,
  updateSettings,
  formatTime12h,
  getStatusIcon,
  isDone,
  isCancelled
} from './data.js';
import { startNotificationLoop, showToast, requestNotificationPermission } from './notifications.js';
import { escapeHTML, formatMeetingCount } from './utils.js';

// ========================================
// 🌐 State
// ========================================

let currentMeetings = [];
let lastSyncTimestamp = null;
let searchQuery = '';
let activeFilter = 'all'; // all, active, completed, cancelled
let clockIntervalId = null;

// ========================================
// ⏰ Live Clock & Daily Stats
// ========================================

function injectDailyStatsUI() {
  const container = document.querySelector('.header-center');
  // Inject "The Core" container if not present
  if (container && !container.querySelector('.daily-stats-container')) {
    const statsHTML = `<div id="daily-stats-container" class="daily-stats-container"></div>`;
    container.insertAdjacentHTML('beforeend', statsHTML);
  }
}

function startClock() {
  injectDailyStatsUI();

  const clockEl = document.getElementById('live-clock');
  const lastUpdatedEl = document.getElementById('last-updated-seconds');

  const update = () => {
    const now = new Date();
    if (clockEl) {
      // 12h Format with Arabic suffixes and English digits
      let h = now.getHours();
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      const suffix = h < 12 ? 'ص' : 'م';
      h = h % 12 || 12;
      clockEl.textContent = `${h}:${m}:${s} ${suffix}`;
    }

    if (lastUpdatedEl && lastSyncTimestamp) {
      const diffSec = Math.floor((now - lastSyncTimestamp) / 1000);
      lastUpdatedEl.textContent = `(منذ ${diffSec} ثانية)`;

      // Visual cue if stale > 5 mins (300s)
      if (diffSec > 300) lastUpdatedEl.style.color = 'var(--neon-red)';
      else lastUpdatedEl.style.color = 'var(--neon-cyan)';
    }

    // Interactive Countdown
    updateCountdownBanner();
  };

  update();
  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = setInterval(update, 1000);
}



// ========================================
// 🎯 Countdown Banner & Progress Bar
// ========================================

function updateCountdownBanner() {
  const banner = document.getElementById('next-meeting-banner');
  const timerEl = document.getElementById('countdown-timer');
  const meetingsList = document.getElementById('banner-meetings-list');
  const progressBar = document.getElementById('time-progress-bar');
  const timeDisplayEl = document.getElementById('next-meeting-time-display');

  if (!banner) return;

  const next = getNextMeeting(currentMeetings);

  if (!next) {
    banner.classList.add('hidden');
    banner.classList.remove('urgent-orange', 'urgent-red');
    return;
  }

  banner.classList.remove('hidden');

  // Calculate countdown
  const now = new Date();
  const [h, min] = next.time.split(':').map(Number);
  const meetingDate = new Date(now);
  meetingDate.setHours(h, min, 0, 0);

  const diffMs = meetingDate - now;
  const diffMin = Math.floor(diffMs / 60000);
  const diffSec = Math.floor((diffMs % 60000) / 1000);

  // --- Urgency Classes ---
  banner.classList.remove('urgent-orange', 'urgent-red');

  if (next.isOverdue) {
    banner.classList.add('urgent-red');
  } else if (diffMin <= 2) {
    banner.classList.add('urgent-red');
  } else if (diffMin <= 10) {
    banner.classList.add('urgent-orange');
  }

  // --- Timer (Right Side) ---
  const isUrgent = diffMin < 5 || next.isOverdue;
  if (next.isOverdue) {
    timerEl.textContent = 'الآن!';
    timerEl.classList.remove('long-format');
  } else {
    if (diffMin > 59) {
      const hours = Math.floor(diffMin / 60);
      const mins = diffMin % 60;
      const secs = Math.max(0, diffSec);
      timerEl.textContent = `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      timerEl.classList.add('long-format');
    } else {
      timerEl.textContent = `${Math.max(0, diffMin)}:${String(Math.max(0, diffSec)).padStart(2, '0')}`;
      timerEl.classList.remove('long-format');
    }
  }
  timerEl.className = `countdown-value${isUrgent ? ' urgent' : ''}${timerEl.classList.contains('long-format') ? ' long-format' : ''}`;

  // --- Progress Bar ---
  let barColor = 'linear-gradient(90deg, var(--neon-cyan), var(--neon-blue))';
  if (next.isOverdue || diffMin < 5) barColor = 'var(--neon-red)';
  else if (diffMin < 15) barColor = 'linear-gradient(90deg, var(--neon-orange), var(--neon-red))';

  const totalMinutesScale = 60;
  const progressPercent = next.isOverdue ? 100 : Math.min(100, Math.max(0, ((totalMinutesScale - diffMin) / totalMinutesScale) * 100));

  if (progressBar) {
    progressBar.style.width = `${progressPercent}%`;
    progressBar.style.background = barColor;
  }

  // --- Meetings List (Left Side) ---
  if (meetingsList) {
    const meetingsHTML = next.meetings.map(m => {
      const ticketMatch = m.project?.match(/AA\d+/);
      const ticketNum = ticketMatch ? ticketMatch[0] : '';
      return `
        <div class="banner-meeting-item">
          <div class="banner-project">${escapeHTML(m.project || '')}</div>
          <div class="banner-team">
            <span><i data-lucide="users" class="icon-small"></i> ${escapeHTML(m.team || '')}</span>
            ${ticketNum ? `<span class="banner-ticket"><i data-lucide="ticket" class="icon-small"></i> #${ticketNum}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    meetingsList.innerHTML = meetingsHTML;
  }

  // Meeting time display
  if (timeDisplayEl) {
    timeDisplayEl.innerHTML = `<i data-lucide="clock" class="icon-small"></i> ${formatTime12h(next.time)}`;
  }
}

// ========================================
// 🎨 Render Meetings (Interactive)
// ========================================

function getStatusClass(status) {
  if (!status) return '';
  const s = status.trim();
  if (s.includes('خارجي')) return 'external';
  if (s.includes('تم') || s.includes('نجاح')) return 'completed';
  if (s.includes('حضوري')) return 'inperson';
  if (s.includes('بعد') || s.includes('عن بعد')) return 'remote';
  return '';
}

function formatDateLabel(dateStr) {
  if (!dateStr) return 'بدون تاريخ';
  try {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const date = new Date(parts[0], parseInt(parts[1]) - 1, parts[2]);
      const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
      return `${days[date.getDay()]} ${parseInt(parts[2])} ${months[date.getMonth()]} ${parts[0]}`;
    }
  } catch { }
  return dateStr;
}

function renderMeetings() {
  const container = document.getElementById('meetings-container');
  if (!container) return;

  if (currentMeetings.length === 0) {
    container.innerHTML = `
      <div class="no-meetings">
        <div class="no-meetings-icon">📡</div>
        <h3>لا توجد اجتماعات</h3>
        <p>قم بضبط إعدادات Google Sheets للمزامنة</p>
      </div>
    `;
    renderDailyStats();
    return;
  }



  // --- FILTERING LOGIC ---
  let filtered = currentMeetings;

  // 1. Search Filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(m =>
      (m.project || '').toLowerCase().includes(q) ||
      (m.team || '').toLowerCase().includes(q) ||
      (m.clientStatus || '').toLowerCase().includes(q) ||
      (m.time || '').includes(q) ||
      (m.date || '').includes(q)
    );
  }

  // 2. Status Filter
  if (activeFilter !== 'all') {
    filtered = filtered.filter(m => {
      const s = (m.status || '').toLowerCase();
      const done = isDone(m);
      const isCancelled_m = s.includes('ملغي') || s.includes('لم يتم') || s.includes('cancel');

      if (activeFilter === 'active') return !done && !isCancelled_m;
      if (activeFilter === 'completed') return done;
      if (activeFilter === 'cancelled') return isCancelled_m;
      return true;
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="no-meetings">
        <div class="no-meetings-icon">🔍</div>
        <h3>لا توجد نتائج</h3>
        <p>جرب تغيير مصطلحات البحث أو الفلتر</p>
      </div>
    `;
    renderDailyStats(); // Still render stats based on ALL meetings? Or filtered? Let's keep it based on today's total.
    return;
  }

  const grouped = groupByDate(filtered);
  const today = formatTodayDate();

  let html = '';
  let globalIndex = 0; // For staggered animation

  for (const [date, meetings] of grouped) {
    const isToday = date === today;
    const dateLabel = formatDateLabel(date);

    html += `
      <div class="date-group">
        <div class="date-group-header ${isToday ? 'today' : ''}">
          <div class="date-label">
            <span class="date-icon">${isToday ? '📌' : '📅'}</span>
            <span class="date-text">${dateLabel}</span>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center">
            ${isToday ? '<span class="today-badge">اليوم</span>' : ''}
            <span class="meeting-count">${formatMeetingCount(meetings.length)}</span>
          </div>
        </div>
        <div class="meetings-table">
    `;

    // --- SMART SORTING UPDATE ---
    const groupA = []; // Active/Upcoming
    const groupB = []; // Archived (تم, ملغي, لم يتم)

    for (const m of meetings) {
      const sLower = (m.status || '').toLowerCase();
      const done = isDone(m);
      const isArchived = done || isCancelled(m) || sLower.includes('postpone');

      if (isArchived) groupB.push(m);
      else groupA.push(m);
    }

    // Sort Group A by time (ensure earliest first)
    groupA.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    const sortedMeetings = [...groupA, ...groupB];

    // --- OPTIMIZATION: Get Next Meeting ONCE outside the loop ---
    const nextBlock = getNextMeeting(currentMeetings);
    const targetIds = new Set(nextBlock ? nextBlock.meetings.map(m => m.id) : []);

    for (const m of sortedMeetings) {
      globalIndex++;
      const statusClass = getStatusClass(m.status);

      // Parse Ticket Number
      const ticketMatch = m.project?.match(/AA\d+/);
      const ticketNum = ticketMatch ? ticketMatch[0] : '';

      // Determine Active State using Persistent Logic (Optimized)
      const isTargeted = targetIds.has(m.id);

      const sLower = (m.status || '').toLowerCase();
      const done = isDone(m);
      const isArchived = done || isCancelled(m) || sLower.includes('postpone');

      // THE GOLDEN RULE + SMART SORT: Never pulse if in Group B
      const isActive = isTargeted && !isArchived;

      // Icon logic - prioritize video if link exists
      const icon = getStatusIcon(m.via, m.status, !!m.meetUrl);

      html += `
        <div class="meeting-row ${isActive ? 'active' : ''} ${isArchived ? 'dimmed' : ''}" 
             style="${isArchived ? 'opacity: 0.5;' : ''}">
          
          <!-- Column 1: Time -->
          <div class="meeting-time">
            ${formatTime12h(m.time) || '--:--'}
          </div>
          
          <!-- Column 2: Meeting Details -->
          <div class="meeting-details">
            <div class="meeting-project-wrapper">
                <div class="meeting-project">${escapeHTML(m.project || '—')}</div>
                ${ticketNum ? `<div class="meeting-ticket-pill">#${ticketNum}</div>` : ''}
            </div>
            <div class="meeting-team-text">${escapeHTML(m.team || '—')}</div>
          </div>
          
          <!-- Column 3: Divider -->
          <div class="meeting-row-divider"></div>

          <!-- Column 4: Control Zone (Badges & Actions) -->
          <div class="meeting-control-zone">
            <!-- Zone A: Badges (Method & Status) -->
            <div class="zone-badges">
              <span class="badge-pill method-badge">
                <i data-lucide="${icon}"></i> ${escapeHTML(m.via || 'اجتماع')}
              </span>
              <span class="badge-pill status-badge ${statusClass}">
                <i data-lucide="${isActive ? 'circle-dot' : 'circle'}"></i> ${escapeHTML(m.status || '—')}
              </span>
            </div>

            <!-- Zone B: Actions -->
            <div class="zone-actions">
              ${ticketNum ? `<button class="btn-action secondary-ghost btn-copy-slack" data-code="${ticketNum}" title="نسخ كود السلاك">
                <i data-lucide="copy"></i> ${ticketNum}
              </button>` : ''}
              
              ${m.meetUrl ? `<a href="${m.meetUrl}" target="_blank" class="btn-action primary-glow">
                <i data-lucide="video"></i> فتح الاجتماع
              </a>` : ''}
              
              ${m.ticketUrl ? `<a href="${m.ticketUrl}" target="_blank" class="btn-action secondary-ghost">
                <i data-lucide="ticket"></i> التذكرة
              </a>` : ''}
            </div>
          </div>

        </div>
      `;
    }

    html += `</div></div>`;
  }

  // --- ANTI-FLICKER: Smart Diffing ---
  if (container.innerHTML !== html) {
    container.innerHTML = html;
    // Initialize Lucide icons
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // Update Daily Stats after render
  renderDailyStats();
}

// ========================================
// 📊 Daily Stats
// ========================================

function renderDailyStats() {
  const container = document.getElementById('daily-stats-container');
  // If element doesn't exist (e.g. init lag), try again next tick
  if (!container) return;

  const todayStr = formatTodayDate();
  const todayMeetings = currentMeetings.filter(m => m.date === todayStr);
  const total = todayMeetings.length;

  // Counts
  const doneCount = todayMeetings.filter(m => isDone(m)).length;
  const cancelledCount = todayMeetings.filter(m => {
    const s = (m.status || '').toLowerCase();
    return s.includes('ملغي') || s.includes('لم يتم') || s.includes('cancel');
  }).length;
  const pendingCount = total - doneCount - cancelledCount;

  // --- Radial Gauge Math ---
  const radius = 70; // Radius of the circle
  const circumference = 2 * Math.PI * radius;

  // Calculate stroke-dasharray (length of each segment)
  // formula: (count / total) * circumference
  const doneLength = total ? (doneCount / total) * circumference : 0;
  const pendingLength = total ? (pendingCount / total) * circumference : 0;
  const cancelledLength = total ? (cancelledCount / total) * circumference : 0;

  // Calculate offsets (starting position of each segment)
  // We rotate -90deg so 0 is at top.
  // Segment 1 (Done) starts at 0.
  // Segment 2 (Pending) starts after Done.
  // Segment 3 (Cancelled) starts after Done + Pending.
  const doneOffset = 0;
  const pendingOffset = -doneLength;
  const cancelledOffset = -(doneLength + pendingLength);

  // HTML Template for "The Core"
  container.innerHTML = `
    <!-- 1. The Radial Gauge (SVG) -->
    <div class="radial-gauge-wrapper breathing">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <!-- Background Track -->
        <circle class="radial-bg" cx="80" cy="80" r="${radius}"></circle>
        
        <!-- Segment 1: Done (Green) -->
        <circle class="radial-segment segment-done" cx="80" cy="80" r="${radius}"
          stroke-dasharray="${doneLength} ${circumference}"
          stroke-dashoffset="${doneOffset}"></circle>
          
        <!-- Segment 2: Pending (Blue/Cyan) -->
        <circle class="radial-segment segment-pending" cx="80" cy="80" r="${radius}"
          stroke-dasharray="${pendingLength} ${circumference}"
          stroke-dashoffset="${pendingOffset}"></circle>
          
        <!-- Segment 3: Cancelled (Red) -->
        <circle class="radial-segment segment-cancelled" cx="80" cy="80" r="${radius}"
          stroke-dasharray="${cancelledLength} ${circumference}"
          stroke-dashoffset="${cancelledOffset}"></circle>
      </svg>
      
      <!-- Center Text -->
      <div class="radial-center-text">
        <span class="radial-total-count">${total}</span>
        <span class="radial-label">الإجمالي</span>
      </div>
    </div>

    <!-- 2. The Legend (Below) -->
    <div class="stats-legend">
      <div class="legend-item" title="مكتمل">
        <span class="legend-dot" style="background:var(--neon-green); box-shadow:0 0 5px var(--neon-green)"></span>
        <span class="legend-label">مكتملة</span>
        <span class="legend-value">${doneCount}</span>
      </div>
      <div class="legend-item" title="قادمة / انتظار">
        <span class="legend-dot" style="background:var(--neon-cyan); box-shadow:0 0 5px var(--neon-cyan)"></span>
        <span class="legend-label">قادمة</span>
        <span class="legend-value">${pendingCount}</span>
      </div>
      <div class="legend-item" title="لم تتم / ملغي">
        <span class="legend-dot" style="background:var(--neon-red); box-shadow:0 0 5px var(--neon-red)"></span>
        <span class="legend-label">لم تتم</span>
        <span class="legend-value">${cancelledCount}</span>
      </div>
    </div>
  `;
}



// ========================================
// ⚙️ UI Logic & Settings Modal
// ========================================

function setupSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const btn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('close-modal-btn');
  const saveBtn = document.getElementById('save-settings-btn');

  const inputSheetId = document.getElementById('sheet-id-input');
  const checkSound = document.getElementById('sound-toggle');
  const checkTheme = document.getElementById('theme-toggle');
  const selectInterval = document.getElementById('refresh-interval');

  // Open Modal
  btn?.addEventListener('click', () => {
    const settings = getSettings();
    if (inputSheetId) inputSheetId.value = settings.sheetId || '';
    if (checkSound) checkSound.checked = settings.soundEnabled;
    if (checkTheme) checkTheme.checked = document.documentElement.classList.contains('light-mode');
    if (selectInterval) selectInterval.value = settings.refreshInterval;

    modal?.classList.remove('hidden');
  });

  // Close Modal
  const close = () => modal?.classList.add('hidden');
  closeBtn?.addEventListener('click', close);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  // Theme Toggle (Immediate Effect)
  checkTheme?.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('light-mode', e.target.checked);
    localStorage.setItem('aait_theme', e.target.checked ? 'light' : 'dark');
  });

  // Save Settings
  saveBtn?.addEventListener('click', () => {
    const newSettings = {
      sheetId: inputSheetId?.value.trim(),
      soundEnabled: checkSound?.checked,
      refreshInterval: parseFloat(selectInterval?.value || '5')
    };

    updateSettings(newSettings);
    close();

    showToast({ title: 'تم الحفظ', message: 'جاري تحديث النظام...', level: 'info' });

    // Restart Sync with new settings
    stopAutoSync();
    initSync();
  });
}

// ========================================
// 🔄 Sync & Actions
// ========================================

function handleSyncResult({ meetings, fromCache, error }) {
  const dot = document.querySelector('.sync-dot');
  const text = document.querySelector('.sync-text');
  const dateEl = document.getElementById('last-sync-time');

  if (!error) {
    lastSyncTimestamp = new Date();

    // 🛡️ SYNC STABILITY CHECK:
    // If we have meetings now, and the new fetch is suddenly empty (and not from cache),
    // it's likely a Google Sheets CDN glitch or temp connection issue.
    // We keep the old data instead of clearing the screen.
    if (meetings.length === 0 && currentMeetings.length > 0 && !fromCache) {
      console.warn('⚠️ Sync returned 0 meetings while state has data. Ignoring update to prevent flickering.');
      showToast({ title: 'تنبيه اتصال', message: 'مزامنة غير مستقرة، تم الإبقاء على البيانات الحالية', level: 'info' });
      return;
    }

    // 3. Updates UI
    currentMeetings = meetings;
    renderMeetings();
    updateCountdownBanner();

    dot?.classList.add('live');
    dot?.classList.remove('error');
    text.textContent = fromCache ? 'مؤقت (Cache)' : 'متصل';

    // Update footer time
    if (dateEl) {
      const now = new Date();
      let h = now.getHours();
      const m = String(now.getMinutes()).padStart(2, '0');
      const suffix = h < 12 ? 'ص' : 'م';
      h = h % 12 || 12;
      dateEl.textContent = `آخر تحديث: ${h}:${m} ${suffix} `;
    }

    // Warning if empty
    if (meetings.length === 0 && !fromCache) {
      showToast({ title: 'تنبيه', message: 'لم يتم العثور على اجتماعات (الجدول فارغ؟)', level: 'warning' });
    }

  } else {
    dot?.classList.add('error');
    text.textContent = 'خطأ اتصال';
    // Don't overwrite currentMeetings on error unless it's initial load? 
    // Actually handleSyncResult doesn't overwrite if error. 
    // Wait, the original code in handleSyncResult was:
    // if (!error) { currentMeetings = meetings; ... }

    showToast({ title: 'خطأ في المزامنة', message: error, level: 'warning', icon: '⚠️' });
  }

  // Stop button spinning
  document.getElementById('sync-now-btn')?.classList.remove('spinning');
}

function initSync() {
  const settings = getSettings();
  if (!settings.sheetId) {
    showToast({ title: 'تنبيه', message: 'يرجى إدخال Sheet ID من الإعدادات', level: 'warning' });
    document.getElementById('settings-btn')?.click(); // Open settings
    return;
  }

  startAutoSync(handleSyncResult);
}

function setupSyncButton() {
  const btn = document.getElementById('sync-now-btn');
  btn?.addEventListener('click', () => {
    btn.classList.add('spinning');
    fetchMeetings().then(handleSyncResult);
  });
}

// ========================================
// 📤 Export Logic
// ========================================



function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// ========================================
// 🔎 Toolbar Logic
// ========================================

function setupToolbar() {
  const toolbar = document.getElementById('toolbar');
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('clear-search');
  const filterBtns = document.querySelectorAll('.filter-btn');

  if (!toolbar) return;

  // Reveal toolbar
  toolbar.classList.remove('hidden');

  // Search Input (Debounced 300ms)
  let debounceTimer;
  searchInput?.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const value = e.target.value.trim();

    debounceTimer = setTimeout(() => {
      searchQuery = value;
      clearBtn?.classList.toggle('hidden', !searchQuery);
      renderMeetings();
    }, 300);
  });

  // Clear Button
  clearBtn?.addEventListener('click', () => {
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    clearBtn.classList.add('hidden');
    renderMeetings();
  });

  // Filter Buttons
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active class from all
      filterBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      // Add to clicked
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');

      // Update state
      activeFilter = btn.dataset.filter;
      renderMeetings();
    });
  });
}

// ========================================
// 🚀 App Initialization
// ========================================

// ========================================
// 📋 Copy to Clipboard
// ========================================

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ title: 'تم النسخ', message: `تم نسخ الكود: ${text}`, level: 'info' });
  } catch (err) {
    console.error('Failed to copy', err);
    showToast({ title: 'خطأ', message: 'فشل النسخ', level: 'warning' });
  }
}

// ========================================
// 🎨 Theme Logic
// ========================================

function setupThemeToggle() {
  const toggleBtn = document.getElementById('header-theme-toggle');

  const updateIcon = (isLight) => {
    if (!toggleBtn) return;
    const iconName = isLight ? 'sun' : 'moon';
    toggleBtn.innerHTML = `<i data-lucide="${iconName}"></i>`;
    if (window.lucide) window.lucide.createIcons();
  };

  const isLight = document.documentElement.classList.contains('light-mode');
  updateIcon(isLight);

  toggleBtn?.addEventListener('click', () => {
    const isLightNow = document.documentElement.classList.toggle('light-mode');
    localStorage.setItem('aait_theme', isLightNow ? 'light' : 'dark');
    updateIcon(isLightNow);

    const settingsToggle = document.getElementById('theme-toggle');
    if (settingsToggle) settingsToggle.checked = isLightNow;
  });
}

// ========================================
// 🖱️ Start Handler
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-btn');
  const overlay = document.getElementById('start-overlay');
  const app = document.getElementById('app');

  // Delegated Event Listener for Copy Buttons
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.btn-copy-slack');
    if (copyBtn) {
      e.preventDefault();
      const code = copyBtn.dataset.code;
      if (code) copyToClipboard(code);
    }
  });

  startBtn?.addEventListener('click', () => {
    requestNotificationPermission();
    overlay.classList.add('hidden');
    app.classList.remove('hidden');
    initApp();
  });
});

function initApp() {
  const savedTheme = localStorage.getItem('aait_theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
  }

  setupThemeToggle(); // Initialize Header Toggle
  startClock();
  setupSettingsModal();
  setupSyncButton();
  setupToolbar();
  initSync();

  // Start notification loop
  startNotificationLoop(
    () => currentMeetings,
    formatTodayDate,
    updateCountdownBanner
  );

  console.log('🚀 AAIT Mission Control initialized');
}
