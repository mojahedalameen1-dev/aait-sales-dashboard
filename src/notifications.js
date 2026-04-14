/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Audio Queue System + Performance Cleanup
 */

import { getSettings, isDone, isCancelled } from './data.js';

// ========================================
// 🔊 Audio System (Queue Based)
// ========================================

/**
 * Audio States
 */
export const AUDIO_STATE = {
    LOCKED: 'locked',
    ENABLED: 'enabled',
    FAILED: 'failed'
};

const playQueue = [];
let isPlaying = false;
let currentAudioState = AUDIO_STATE.LOCKED;
let onStateChangeCallback = null;

// Track recently warned meetings to avoid spamming fallbacks
const recentlyWarnedMeetings = new Map(); // id -> timestamp

/**
 * Set a callback for UI updates when audio state changes
 */
export function setAudioStateListener(callback) {
    onStateChangeCallback = callback;
}

function updateAudioState(newState) {
    if (currentAudioState === newState) return;
    currentAudioState = newState;
    console.log(`[Audio] State changed to: ${newState}`);
    if (onStateChangeCallback) onStateChangeCallback(newState);
}

/**
 * "Unlock" audio context. Called from user interaction.
 */
export function unlockAudio() {
    if (currentAudioState === AUDIO_STATE.ENABLED) return;

    const silentAudio = new Audio();
    silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAA'
        + 'ABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

    silentAudio.onended = () => {
        updateAudioState(AUDIO_STATE.ENABLED);
        processQueue();
    };

    silentAudio.onerror = () => {
        console.error('[Audio] Unlock failed: audio load error');
        updateAudioState(AUDIO_STATE.FAILED);
    };

    silentAudio.play().catch(err => {
        console.error('[Audio] Unlock play() rejected:', err.name);
        updateAudioState(AUDIO_STATE.FAILED);
    });
}

/**
 * Add audio task to queue
 */
function enqueueAudio(task) {
    const { soundEnabled } = getSettings();
    if (!soundEnabled) return;

    console.log(`[Queue] Queued: ${task.filename || task}`);
    playQueue.push(task);
    processQueue();
}

/**
 * Process the Audio Queue (STRICT MODE: Files Only)
 */
async function processQueue() {
    if (isPlaying || playQueue.length === 0) return;
    
    if (currentAudioState !== AUDIO_STATE.ENABLED) {
        console.warn('[Queue] Waiting for Audio Unlock...');
        return;
    }

    isPlaying = true;
    const task = playQueue.shift();
    const filename = task.filename || task;
    
    const finish = (delay = 2000) => {
        setTimeout(() => {
            isPlaying = false;
            processQueue();
        }, delay);
    };

    try {
        const audioPath = `/sounds/${filename}`;
        console.log(`[Queue] Stage: Playing -> ${filename}`);
        
        const audio = new Audio(audioPath);
        let playCount = 1;

        audio.onended = () => {
            if (playCount < 2) {
                playCount++;
                setTimeout(() => {
                    console.log(`[Queue] Stage: Replaying -> ${filename}`);
                    audio.play().catch(e => {
                        console.error('[Queue] Replay Failed:', e);
                        finish(500);
                    });
                }, 5000);
            } else {
                console.log('[Queue] Stage: Completed');
                finish(2000);
            }
        };

        audio.onerror = () => {
            console.error(`[Queue] Stage: Failed (File NOT FOUND: ${filename}). Skipping.`);
            finish(0); // Proceed immediately if file is missing
        };

        await audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') {
                updateAudioState(AUDIO_STATE.LOCKED);
            } else {
                console.error('[Queue] Play Error:', err);
            }
            finish(500);
        });
    } catch (e) {
        console.error('[Queue] Unexpected Error:', e);
        finish(500);
    }
}

/**
 * Map Arabic Name to Audio File Prefix
 * UPDATED: Added Hossam ( حـسام ) -> 'a'
 */
function getEngineerPrefix(teamName) {
    if (!teamName) return null;
    const lowerName = teamName.toLowerCase();

    if (lowerName.includes("مجاهد")) return 'm';
    if (lowerName.includes("شادي")) return 's';
    if (lowerName.includes("أشرف") || lowerName.includes("اشرف") || lowerName.includes("حسام")) return 'a';

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

// FUNC-03: Periodic clear to prevent memory accumulation and allow re-notifying if needed (e.g. after a fix)
setInterval(() => {
    triggeredNotifications.clear();
    // console.log('🕒 Hourly notification set cleanup');
}, 60 * 60 * 1000);

export function checkMeetingTimers(meetings, todayDate) {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time);

    for (const meeting of todayMeetings) {
        if (isDone(meeting) || isCancelled(meeting)) continue;

        const [h, min] = meeting.time.split(':').map(Number);
        if (isNaN(h) || isNaN(min)) continue;

        const meetingMinutes = h * 60 + min;
        const diff = meetingMinutes - nowMinutes;

        const prefix = getEngineerPrefix(meeting.team);

        // Logic A: 30 Minutes Warning (Expanded window: 28 to 32)
        if (diff >= 28 && diff <= 32) {
            const key = `${meeting.id}_30min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                triggerAlert(meeting, prefix, 30, diff);
            }
        }

        // Logic B: 5 Minutes Warning (Expanded window: 3 to 7)
        if (diff >= 3 && diff <= 7) {
            const key = `${meeting.id}_5min`;
            if (!triggeredNotifications.has(key)) {
                triggeredNotifications.add(key);
                triggerAlert(meeting, prefix, 5, diff);
            }
        }
    }
}

function triggerAlert(meeting, prefix, minutesType, diff) {
    if (prefix) {
        const filename = `${prefix}${minutesType}.mp3`;
        enqueueAudio({ filename, meetingId: meeting.id });
    } else {
        console.warn(`[Audio] No mapping found for engineer: "${meeting.team}" (id: ${meeting.id}). Skipping sound.`);
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
