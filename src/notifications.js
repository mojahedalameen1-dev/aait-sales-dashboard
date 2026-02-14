/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Audio Queue System + Performance Cleanup
 */

import { getSettings, isDone } from './data.js';

// ========================================
// 🔊 Audio System (Queue Based)
// ========================================

const playQueue = [];
let isPlaying = false;

/**
 * Add audio to queue and attempt to process
 * @param {string} filename - The name of the MP3 file in /public/sounds/
 */
function playNotificationSound(filename) {
    const { soundEnabled } = getSettings();
    if (!soundEnabled) return;

    // Add to queue
    playQueue.push(filename);
    processQueue();
}

/**
 * Process the next item in the Audio Queue
 */
function processQueue() {
    // If already playing or empty, do nothing
    if (isPlaying || playQueue.length === 0) return;

    isPlaying = true;
    const filename = playQueue.shift();
    const audioPath = `/sounds/${filename}`;

    // console.log(`🔊 Processing Queue: ${audioPath} (Remaining: ${playQueue.length})`);

    const audio = new Audio(audioPath);

    const finish = () => {
        // Small buffer before next track
        setTimeout(() => {
            isPlaying = false;
            processQueue();
        }, 1000);
    };

    // Play Logic (Double Replay)
    let playCount = 1;

    audio.onended = () => {
        if (playCount < 2) {
            playCount++;
            setTimeout(() => {
                // console.log(`🔊 Replaying: ${audioPath}`);
                audio.play().catch(err => {
                    console.error("Audio replay error:", err);
                    finish();
                });
            }, 5000); // 5 seconds delay between loops
        } else {
            finish();
        }
    };

    audio.onerror = (err) => {
        console.error("Audio Load Error:", err);
        finish();
    };

    audio.play().catch(err => {
        console.error("Audio play error:", err);
        finish();
    });
}

/**
 * Map Arabic Name to Audio File Prefix
 * @param {string} teamName - The team string from the meeting
 * @returns {string|null} - 'm', 's', 'a', or null if no match
 */
function getEngineerPrefix(teamName) {
    if (!teamName) return null;
    const lowerName = teamName.toLowerCase();

    if (lowerName.includes("مجاهد")) return 'm';
    if (lowerName.includes("شادي")) return 's';
    if (lowerName.includes("أشرف") || lowerName.includes("اشرف")) return 'a';

    return null;
}

// ========================================
// 🔔 Visual Toast Notifications
// ========================================

const TOAST_DURATION = 15000; // 15 seconds

export function showToast({ title, message, level = 'info', icon = '🔔' }) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${level}`;

    const iconMap = {
        'info': 'info',
        'warning': 'alert-triangle',
        'critical': 'alert-circle'
    };
    const lucideIcon = iconMap[level] || 'bell';

    toast.innerHTML = `
    <span class="toast-icon"><i data-lucide="${lucideIcon}"></i></span>
    <div class="toast-body">
      <div class="toast-title"></div>
      <div class="toast-message"></div>
    </div>
    <button class="toast-close" onclick="this.closest('.notification-toast').classList.add('exiting'); setTimeout(() => this.closest('.notification-toast')?.remove(), 300)">✕</button>
  `;

    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-message').textContent = message;

    container.prepend(toast);

    if (window.lucide) {
        window.lucide.createIcons();
    }

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

const triggeredNotifications = new Set();
let lastNotifiedDate = new Date().toDateString();

function resetNotificationsIfNewDay() {
    const today = new Date().toDateString();
    if (today !== lastNotifiedDate) {
        triggeredNotifications.clear();
        lastNotifiedDate = today;
        // console.log('🔄 Daily notification reset');
    }
}

export function checkMeetingTimers(meetings, todayDate) {
    resetNotificationsIfNewDay();
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time);

    for (const meeting of todayMeetings) {
        const status = (meeting.status || '').trim();
        if (status === "ملغي" || status === "لم يتم" || status === "تم") continue;

        const [h, min] = meeting.time.split(':').map(Number);
        if (isNaN(h) || isNaN(min)) continue;

        const meetingMinutes = h * 60 + min;
        const diff = meetingMinutes - nowMinutes;

        // console.log(`[Timer] ${meeting.id} (${meeting.time}): diff=${diff}m`); // Removed to save memory

        const prefix = getEngineerPrefix(meeting.team);

        // Logic A: 30 Minutes Warning (29 <= diff <= 30)
        if (diff >= 29 && diff <= 30) {
            const key = `${meeting.id}_30min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                console.log(`[Trigger] 30m Audio for ${meeting.id}`);
                triggerAlert(meeting, prefix, 30, diff);
            }
        }

        // Logic B: 5 Minutes Warning (4 <= diff <= 5)
        if (diff >= 4 && diff <= 5) {
            const key = `${meeting.id}_5min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                console.log(`[Trigger] 5m Audio for ${meeting.id}`);
                triggerAlert(meeting, prefix, 5, diff);
            }
        }
    }
}

function triggerAlert(meeting, prefix, minutesType, diff) {
    if (prefix) {
        const filename = `${prefix}${minutesType}.mp3`;
        playNotificationSound(filename);
    }

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

    sendPushNotification(meeting, timeText);
}

function sendPushNotification(meeting, timeText) {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        new Notification(`تنبيه: ${meeting.project}`, {
            body: `${meeting.team || 'الفريق'} - ${timeText}`,
            silent: true
        });
    }
}

// ========================================
// 🔁 Timer Loop
// ========================================

let timerInterval = null;

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
        const meetings = getMeetings();
        const today = getTodayDate();
        checkMeetingTimers(meetings, today);
        if (onTick) onTick();
    }, 30 * 1000);

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
