/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Removed TTS/Chime, added strict file-based audio for specific engineers.
 */

import { getSettings, isDone } from './data.js';

// ========================================
// 🔊 Audio System (File Based)
// ========================================

/**
 * Play a specific audio file twice with a 5-second delay between plays.
 * @param {string} filename - The name of the MP3 file in /public/sounds/
 */
function playNotificationSound(filename) {
    const { soundEnabled } = getSettings();
    if (!soundEnabled) return;

    const audioPath = `/sounds/${filename}`;
    console.log(`🔊 Playing sound: ${audioPath}`);

    const audio = new Audio(audioPath);

    // Play first time
    audio.play().catch(err => console.error("Audio play error:", err));

    // When ended, wait 5 seconds then play again ONCE
    // We use a flag to track if it's the first or second play
    let playCount = 1;

    audio.onended = () => {
        if (playCount < 2) {
            playCount++;
            setTimeout(() => {
                console.log(`🔊 Playing sound again (iteration ${playCount}): ${audioPath}`);
                audio.play().catch(err => console.error("Audio replay error:", err));
            }, 5000); // 5 seconds delay
        }
    };
}

/**
 * Map Arabic Name to Audio File Prefix
 * @param {string} teamName - The team string from the meeting
 * @returns {string|null} - 'm', 's', 'a', or null if no match
 */
function getEngineerPrefix(teamName) {
    if (!teamName) return null;
    const lowerName = teamName.toLowerCase(); // Just in case, though usually Arabic

    if (lowerName.includes("مجاهد")) return 'm';
    if (lowerName.includes("شادي")) return 's';
    if (lowerName.includes("أشرف") || lowerName.includes("اشرف")) return 'a';

    return null;
}

// ========================================
// 🔔 Visual Toast Notifications (Kept for UI feedback)
// ========================================

const TOAST_DURATION = 15000; // 15 seconds

export function showToast({ title, message, level = 'info', icon = '🔔' }) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${level}`;

    // Lucide icon map
    const iconMap = {
        'info': 'info',
        'warning': 'alert-triangle',
        'critical': 'alert-circle'
    };
    const lucideIcon = iconMap[level] || 'bell';

    toast.innerHTML = `
    <span class="toast-icon"><i data-lucide="${lucideIcon}"></i></span>
    <div class="toast-body">
      <div class="toast-title"></div> <!-- Set via textContent below -->
      <div class="toast-message"></div> <!-- Set via textContent below -->
    </div>
    <button class="toast-close" onclick="this.closest('.notification-toast').classList.add('exiting'); setTimeout(() => this.closest('.notification-toast')?.remove(), 300)">✕</button>
  `;

    // Securely set text content to prevent XSS
    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-message').textContent = message;

    container.prepend(toast);

    // Initialize Lucide icons
    if (window.lucide) {
        window.lucide.createIcons();
    }

    // Auto-dismiss
    setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.add('exiting');
            setTimeout(() => toast.remove(), 300);
        }
    }, TOAST_DURATION);
}

// ========================================
// ⏰ Meeting Timer / Notification Engine
// ========================================

// Track unique trigger events to prevent spamming
// Format: `${meetingId}_${type}` where type is '30min' or '5min'
const triggeredNotifications = new Set();
let lastNotifiedDate = new Date().toDateString();

// Reset notifications daily
function resetNotificationsIfNewDay() {
    const today = new Date().toDateString();
    if (today !== lastNotifiedDate) {
        triggeredNotifications.clear();
        lastNotifiedDate = today;
        console.log('🔄 Daily notification reset');
    }
}

export function checkMeetingTimers(meetings, todayDate) {
    resetNotificationsIfNewDay();
    const now = new Date();
    // Use getHours/getMinutes for local time comparison as per requirement
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time);

    for (const meeting of todayMeetings) {
        // Skip invalid status
        const status = (meeting.status || '').trim();
        if (status === "ملغي" || status === "لم يتم" || status === "تم") continue;

        const [h, min] = meeting.time.split(':').map(Number);
        if (isNaN(h) || isNaN(min)) continue;


        const meetingMinutes = h * 60 + min;
        const diff = meetingMinutes - nowMinutes;

        console.log(`[Timer] ${meeting.id} (${meeting.time}): diff=${diff}m`);

        const prefix = getEngineerPrefix(meeting.team);

        // Logic A: 30 Minutes Warning (29 <= diff <= 30)
        // Check if we are in the window AND haven't triggered this specific alert yet
        if (diff >= 29 && diff <= 30) {
            const key = `${meeting.id}_30min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                console.log(`[Trigger] 30m Audio for ${meeting.id} (Diff: ${diff})`);
                triggerAlert(meeting, prefix, 30, diff);
            }
        }

        // Logic B: 5 Minutes Warning (4 <= diff <= 5)
        if (diff >= 4 && diff <= 5) {
            const key = `${meeting.id}_5min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                console.log(`[Trigger] 5m Audio for ${meeting.id} (Diff: ${diff})`);
                triggerAlert(meeting, prefix, 5, diff);
            }
        }
    }
}

function triggerAlert(meeting, prefix, minutesType, diff) {
    // 1. Play Sound (if prefix exists)
    if (prefix) {
        const filename = `${prefix}${minutesType}.mp3`;
        playNotificationSound(filename);
    }

    // 2. Show Visual Toast (Always, regardless of prefix)
    const timeText = diff <= 1 ? 'سيبدأ الآن' : `بعد ${diff} دقيقة`;
    let level = 'info';
    let icon = 'bell';

    if (minutesType === 5) {
        level = 'warning';
        icon = 'alert-triangle';
    }

    showToast({
        title: meeting.project || 'تنبيه اجتماع',
        message: `${meeting.team || ''} — ${timeText}`,
        level,
        icon
    });

    // 3. Browser Push Notification
    sendPushNotification(meeting, timeText);
}

/**
 * Trigger browser push notification
 */
function sendPushNotification(meeting, timeText) {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        new Notification(`تنبيه: ${meeting.project}`, {
            body: `${meeting.team || 'الفريق'} - ${timeText}`,
            silent: true // We handle sound manually
        });
    }
}

// ========================================
// 🔁 Timer Loop
// ========================================

let timerInterval = null;

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    if (timerInterval) clearInterval(timerInterval);

    // Check every 30 seconds
    timerInterval = setInterval(() => {
        const meetings = getMeetings();
        const today = getTodayDate();
        checkMeetingTimers(meetings, today);
        if (onTick) onTick();
    }, 30 * 1000);

    // Initial check
    const meetings = getMeetings();
    const today = getTodayDate();
    checkMeetingTimers(meetings, today);
}

export function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
    });
}
