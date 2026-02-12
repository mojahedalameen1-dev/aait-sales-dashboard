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
import { unlockAudio, startNotificationLoop, testNotification, showToast, requestNotificationPermission } from './notifications.js';
import { escapeHTML } from './utils.js';

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
  if (container && !container.querySelector('.daily-stats-container')) {
    const statsHTML = `
      <div class="daily-stats-container">
        <div id="daily-stats-text" class="daily-stats-text">إحصائيات اليوم: 0 / 0</div>
        <div class="daily-progress-bg">
          <div id="daily-progress-fill" class="daily-progress-fill"></div>
        </div>
      </div>
    `;
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

  // Initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
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
            <span class="meeting-count">${meetings.length} اجتماع</span>
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

      // Icon
      const icon = getStatusIcon(m.via, m.status);

      html += `
        <div class="meeting-row ${isActive ? 'active' : ''} ${isArchived ? 'dimmed' : ''}" 
             style="${isArchived ? 'opacity: 0.5;' : ''}">
          <div class="meeting-time">
            ${formatTime12h(m.time) || '--:--'}
          </div>
          
          <div class="meeting-info">
            <div class="meeting-project">${escapeHTML(m.project || '—')}</div>
            ${ticketNum ? `<div class="meeting-ticket">#${ticketNum}</div>` : ''}
          </div>
          
          <div class="meeting-team">${escapeHTML(m.team || '—')}</div>
          
          <div class="meeting-status">
            <span class="status-badge ${statusClass}">
              <i data-lucide="${icon}"></i> ${escapeHTML(m.status || '—')}
            </span>
          </div>

          <div class="meeting-actions">
            ${m.meetUrl ? `<a href="${m.meetUrl}" target="_blank" class="btn-action">
              <i data-lucide="video"></i> فتح الاجتماع
            </a>` : ''}
            ${m.ticketUrl ? `<a href="${m.ticketUrl}" target="_blank" class="btn-action secondary">
              <i data-lucide="ticket"></i> التذكرة
            </a>` : ''}
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
  // Use the container injected by injectDailyStatsUI
  const statsText = document.getElementById('daily-stats-text');
  const progressFill = document.getElementById('daily-progress-fill');

  // If elements don't exist (e.g. init lag), try again next tick
  if (!statsText || !progressFill) return;

  const todayStr = formatTodayDate();
  const todayMeetings = currentMeetings.filter(m => m.date === todayStr);
  const total = todayMeetings.length;

  if (total === 0) {
    statsText.textContent = `إحصائيات اليوم: 0 / 0`;
    progressFill.style.width = '0%';
    return;
  }

  const doneCount = todayMeetings.filter(m => isDone(m)).length;
  // Advanced Stats Calculation
  const cancelledCount = todayMeetings.filter(m => {
    const s = (m.status || '').toLowerCase();
    return s.includes('ملغي') || s.includes('لم يتم') || s.includes('cancel');
  }).length;

  const pendingCount = total - doneCount - cancelledCount;
  const percentage = Math.round((doneCount / total) * 100);

  // Update Text & Width
  statsText.innerHTML = `
      < span title = "مكتمل" >✅ ${doneCount}</span > /
        < span title = "الإجمالي" > ${total}</span > 
    <span class="divider">|</span> 
    <span title="قيد الانتظار" style="color:var(--neon-cyan)">⏳ ${pendingCount}</span>
    <span title="ملغي" style="color:var(--neon-red)">🚫 ${cancelledCount}</span>
    `;

  progressFill.style.width = `${percentage}% `;

  // Color logic based on completion
  if (percentage === 100) {
    progressFill.style.background = 'var(--neon-green)';
    progressFill.style.boxShadow = '0 0 10px var(--neon-green)';
  } else {
    progressFill.style.background = 'linear-gradient(90deg, var(--neon-cyan), var(--neon-blue))';
    progressFill.style.boxShadow = '0 0 5px var(--neon-blue)';
  }
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

  } else {
    dot?.classList.add('error');
    text.textContent = 'خطأ اتصال';
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

function setupExport() {
  const exportBtn = document.getElementById('export-btn');
  const exportModal = document.getElementById('export-modal');
  const closeExportBtn = document.getElementById('close-export-btn');
  const btnCsv = document.getElementById('export-csv');
  const btnPrint = document.getElementById('export-print');
  const btnCopy = document.getElementById('export-copy');

  if (!exportBtn || !exportModal) return;

  // Open/Close
  exportBtn.addEventListener('click', () => {
    exportModal.classList.remove('hidden');
    closeExportBtn?.focus(); // Accessibility focus
  });
  closeExportBtn?.addEventListener('click', () => {
    exportModal.classList.add('hidden');
    exportBtn?.focus(); // Return focus
  });
  exportModal.addEventListener('click', (e) => {
    if (e.target === exportModal) exportModal.classList.add('hidden');
  });

  // 1. CSV Export
  btnCsv?.addEventListener('click', () => {
    const headers = ['المشروع', 'الفريق', 'الوقت', 'الحالة', 'العميل'];
    const rows = currentMeetings.map(m => [
      `"${m.project || ''}"`,
      `"${m.team || ''}"`,
      `"${m.time || ''}"`,
      `"${m.status || ''}"`,
      `"${m.clientStatus || ''}"`
    ]);

    const csvContent = "\uFEFF" + [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `meetings_${formatDate(new Date())}.csv`;
    link.click();
    exportModal.classList.add('hidden');
  });

  // 2. Print View
  btnPrint?.addEventListener('click', () => {
    window.print(); // Relies on @media print CSS
    exportModal.classList.add('hidden');
  });

  // 3. Copy to Clipboard
  btnCopy?.addEventListener('click', () => {
    const text = currentMeetings.map(m =>
      `📌 * ${m.project}* | ${m.team} \n🕒 ${m.time} | س: ${m.status} `
    ).join('\n\n');

    navigator.clipboard.writeText(text).then(() => {
      showToast({ title: 'تم النسخ', message: 'تم نسخ جدول الاجتماعات للحافظة بنجاح ✅', level: 'info' });
      exportModal.classList.add('hidden');
    });
  });
}

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

function initApp() {
  // Load Theme
  const savedTheme = localStorage.getItem('aait_theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
  }

  startClock();
  setupSettingsModal();
  setupSyncButton();
  setupToolbar();
  setupExport();
  initSync();

  // Start notification loop
  startNotificationLoop(
    () => currentMeetings,
    formatTodayDate,
    updateCountdownBanner
  );

  console.log('🚀 AAIT Mission Control initialized');
}

// ========================================
// 🖱️ Start Handler
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-btn');
  const overlay = document.getElementById('start-overlay');
  const app = document.getElementById('app');

  startBtn?.addEventListener('click', () => {
    unlockAudio();
    requestNotificationPermission(); // Request permission
    overlay.classList.add('hidden');
    app.classList.remove('hidden');
    initApp();
  });
});
