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
import { escapeHTML, formatMeetingCount, getArabicMeetingParts } from './utils.js';

// ========================================
// 🌐 State
// ========================================

let currentMeetings = [];
let lastSyncTimestamp = null;
let searchQuery = '';
let activeFilter = 'all'; // all, active, completed, cancelled
let clockIntervalId = null;
const prevStatusMap = new Map(); // Track previous meeting status for animations

// --- Developer Identity System ---
const DEV_COLORS = {
  'أشرف': { color: 'var(--dev-emerald)', initial: 'أ' },
  'مجاهد': { color: 'var(--dev-sky)', initial: 'م' },
  'شادي': { color: 'var(--dev-rose)', initial: 'ش' },
  'حسام': { color: 'var(--dev-amber)', initial: 'ح' },
  'default': { color: 'var(--text-faint)', initial: '؟' }
};

function getDevInfo(name) {
  return DEV_COLORS[name] || DEV_COLORS['default'];
}

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

    // Interactive Hero Section
    updateHeroSection();
  };

  update();
  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = setInterval(update, 1000);
}



// ========================================
// 🎯 Countdown Banner & Progress Bar
// ========================================

function updateHeroSection() {
  const container = document.getElementById('hero-container');
  const miniTimeline = document.getElementById('mini-timeline');
  if (!container) return;

  const next = getNextMeeting(currentMeetings);

  // --- Sub-Zone Right: Mini Timeline ---
  if (miniTimeline) {
    const upcoming = currentMeetings.filter(m => {
       const done = isDone(m);
       const cancelled = isCancelled(m);
       return !done && !cancelled;
    }).slice(0, 5);
    
    miniTimeline.innerHTML = upcoming.map(m => {
       const dev = getDevInfo(m.team);
       return `
         <div class="mini-tile">
            <span class="mini-time">${formatTime12h(m.time)}</span>
            <span class="dev-dot" style="background:${dev.color}"></span>
            <span class="mini-client">${escapeHTML(m.project || '—')}</span>
         </div>
       `;
    }).join('');
  }

  if (!next) {
    const today = formatTodayDate();
    const todayMeetings = currentMeetings.filter(m => m.date === today);
    const hasMeetingsToday = todayMeetings.length > 0;
    const allFinished = hasMeetingsToday && todayMeetings.every(m => isDone(m) || isCancelled(m));

    if (allFinished) {
      container.innerHTML = `
        <div style="text-align:center; padding:var(--s8);">
          <h2 style="font-size:var(--t-lg); color:var(--dev-emerald);">✅ تم إكمال جميع اجتماعات اليوم</h2>
          <p style="color:var(--text-muted); margin-top:var(--s2);">عمل رائع للفريق!</p>
        </div>
      `;
      return;
    }
    container.innerHTML = `<div style="text-align:center; color:var(--text-faint);">بانتظار اجتماعات جديدة...</div>`;
    return;
  }

  const now = new Date();
  const [h, min] = next.time.split(':').map(Number);
  const meetingDate = new Date(now);
  meetingDate.setHours(h, min, 0, 0);

  const diffMs = meetingDate - now;
  const diffMin = Math.floor(diffMs / 60000);
  const diffSec = Math.floor((diffMs % 60000) / 1000);

  // --- Urgency Logic ---
  let urgencyClass = '';
  if (next.isOverdue || diffMin < 5) urgencyClass = 'timer-red';
  else if (diffMin < 15) urgencyClass = 'timer-amber';

  // --- Timer Text ---
  let timerText = '';
  if (next.isOverdue) {
    timerText = 'الآن!';
  } else {
    timerText = `${Math.max(0, diffMin)}:${String(Math.max(0, diffSec)).padStart(2, '0')}`;
  }

  const m = next.meetings[0]; // Hero focuses on the primary next meeting
  const dev = getDevInfo(m.team);
  const typeIcon = getStatusIcon(m.via, m.status, !!m.meetUrl);
  const iconMap = { 'video': '📹', 'car': '🚗', 'building-2': '🏢', 'calendar': '📅' };

  container.innerHTML = `
    <div class="hero-header">
       <span class="badge-now">${next.isOverdue ? 'اجتماع جاري' : 'الاجتماع القادم'}</span>
    </div>
    
    <div class="hero-main">
       <div class="hero-client">${escapeHTML(m.project || 'عميل جديد')}</div>
       <div class="hero-project">${escapeHTML(m.team || 'فريق المبيعات')} • ${iconMap[typeIcon] || '📅'} ${escapeHTML(m.via || 'اجتماع')}</div>
       <div class="hero-timer ${urgencyClass}">${timerText}</div>
    </div>
    
    <div class="hero-footer">
       <div class="dev-avatar-large" style="background:${dev.color}">${dev.initial}</div>
       <div style="text-align:right;">
          <div style="font-size:var(--t-xs); color:var(--text-muted);">المسؤول</div>
          <div style="font-weight:700;">${escapeHTML(m.team)}</div>
       </div>
       ${m.meetUrl ? `
         <a href="${m.meetUrl}" target="_blank" class="btn-join">
           دخول الاجتماع
         </a>
       ` : ''}
    </div>
  `;
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

  const todayStr = formatTodayDate();
  
  // Filter and sort for Today's Timeline
  let filtered = currentMeetings;

  // 1. Search & Status Filters
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(m =>
      (m.project || '').toLowerCase().includes(q) ||
      (m.team || '').toLowerCase().includes(q)
    );
  }

  if (activeFilter !== 'all') {
    filtered = filtered.filter(m => {
      const done = isDone(m);
      const cancelled = isCancelled(m);
      if (activeFilter === 'active') return !done && !cancelled;
      if (activeFilter === 'completed') return done;
      if (activeFilter === 'cancelled') return cancelled;
      return true;
    });
  }

  // Focus only on today for the wallboard strip
  const todayMeetings = filtered.filter(m => m.date === todayStr);
  todayMeetings.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (todayMeetings.length === 0) {
    container.innerHTML = `<div style="width:100%; display:flex; align-items:center; justify-content:center; color:var(--text-faint);">لا توجد اجتماعات مقررة لهذا اليوم</div>`;
    renderDailyStats();
    return;
  }

  const nextBlock = getNextMeeting(currentMeetings);
  const targetIds = new Set(nextBlock ? nextBlock.meetings.map(m => m.id) : []);
  const now = new Date();

  container.innerHTML = todayMeetings.map(m => {
    const dev = getDevInfo(m.team);
    const done = isDone(m);
    const cancelled = isCancelled(m);
    const isTargeted = targetIds.has(m.id);
    const isArchived = done || cancelled;
    
    // Urgency Logic for Tile
    const [h, min] = m.time.split(':').map(Number);
    const mDate = new Date(now);
    mDate.setHours(h, min, 0, 0);
    const diffMin = (mDate - now) / 60000;
    
    let stateClass = '';
    if (done) stateClass = 'tile-completed';
    else if (cancelled) stateClass = 'tile-missed';
    else if (isTargeted) stateClass = 'tile-current';
    else if (diffMin > 0 && diffMin < 15) stateClass = 'tile-urgent';
    else if (diffMin < 0) stateClass = 'tile-missed'; // Overdue but not current

    const typeIconName = getStatusIcon(m.via, m.status, !!m.meetUrl);
    const iconMap = { 'video': '📹', 'car': '🚗', 'building-2': '🏢', 'calendar': '📅' };

    return `
      <div class="timeline-tile ${stateClass}" style="border-left-color: ${dev.color}">
        <div class="tile-time">${formatTime12h(m.time)}</div>
        <div class="tile-client" title="${escapeHTML(m.project)}">${escapeHTML(m.project)}</div>
        <div class="tile-project">${escapeHTML(m.team)}</div>
        
        <div class="tile-footer">
           <div class="dev-avatar-sm" style="background:${dev.color}">${dev.initial}</div>
           <span class="type-icon">${iconMap[typeIconName] || '📅'}</span>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons();
  renderDailyStats();
}

// ========================================
// 📊 Daily Stats
// ========================================

function renderDailyStats() {
  const container = document.getElementById('daily-stats-container');
  if (!container) return;

  const todayStr = formatTodayDate();
  const todayMeetings = currentMeetings.filter(m => m.date === todayStr);
  const total = todayMeetings.length;

  const doneCount = todayMeetings.filter(m => isDone(m)).length;
  const cancelledCount = todayMeetings.filter(m => isCancelled(m)).length;
  const pendingCount = total - doneCount - cancelledCount;

  // Urgent Count (Today meetings < 15 mins away or overdue)
  const now = new Date();
  const urgentCount = todayMeetings.filter(m => {
     if (isDone(m) || isCancelled(m)) return false;
     const [h, min] = m.time.split(':').map(Number);
     const mDate = new Date(now);
     mDate.setHours(h, min, 0, 0);
     const diffMin = (mDate - now) / 60000;
     return diffMin <= 15;
  }).length;

  container.innerHTML = `
    <div class="kpi-chip">
      <span class="kpi-label">مكتملة اليوم</span>
      <span class="kpi-value text-emerald">${doneCount}</span>
    </div>
    <div class="kpi-chip">
      <span class="kpi-label">القادمة</span>
      <span class="kpi-value text-sky">${pendingCount}</span>
    </div>
    <div class="kpi-chip ${urgentCount > 0 ? 'tile-urgent' : ''}">
      <span class="kpi-label">عاجلة / الآن</span>
      <span class="kpi-value ${urgentCount > 0 ? 'text-rose' : 'text-faint'}">${urgentCount}</span>
    </div>
    <div class="kpi-chip">
      <span class="kpi-label">إجمالي الاجتماعات</span>
      <span class="kpi-value">${total}</span>
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
    // 3. Updates UI
    currentMeetings = meetings;
    renderMeetings();
    updateHeroSection();

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
    updateHeroSection
  );

  console.log('🚀 AAIT Mission Control initialized');
}
